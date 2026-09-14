import { Popcorn } from './wasm/popcorn.js';

/**
 * Driver for the Popcorn 0.3 runtime: boots AtomVM in an iframe and evaluates
 * Elixir through the `eval_elixir` action exposed by the vendored bundle.
 *
 * Two runtime behaviours shape the code below, both verified against this exact
 * bundle rather than assumed:
 *
 *   - A successful call resolves with the *inspected value itself* (older bundle
 *     shape: `inspect/1` of the last expression, as a string), not an object.
 *   - An uncaught Elixir error **aborts the VM**. The call is acknowledged and
 *     then never answered, so it surfaces as a client-side timeout, and the next
 *     call's `noproc` triggers an iframe reload. A timeout therefore means the
 *     instance is dead, and the driver restarts it rather than reusing it.
 */

const EVAL_ELIXIR = 'eval_elixir';
// An error and a long-running program are indistinguishable here — neither
// replies — so this only decides how long the UI waits before giving up.
const EVAL_TIMEOUT_MS = 15_000;

const TIMEOUT_MESSAGE =
  `No reply within ${EVAL_TIMEOUT_MS / 1000} s, so the runtime has stopped. An uncaught Elixir ` +
  'error aborts the VM, and a program that loops forever never answers. The runtime has been ' +
  'restarted — run again.';

const RELOADED_MESSAGE =
  'The runtime restarted mid-run (an earlier program aborted it). Run again.';

// `init` hanging is the signature of a document that is not cross-origin
// isolated — verified by serving the same page with and without COOP/COEP.
const BOOT_TIMEOUT_MESSAGE =
  'The runtime did not start. This page must be served cross-origin isolated: ' +
  'Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp ' +
  '(serve.js sets both). Without them SharedArrayBuffer is unavailable and AtomVM cannot boot.';

const EXAMPLES = [
  {
    name: 'Hello world',
    code: `IO.puts("Hello from Elixir!")
IO.puts("This is running in your browser, with no server.")
`,
  },
  {
    name: 'Pipes and Enum',
    code: `1..10
|> Enum.filter(&(rem(&1, 2) == 0))
|> Enum.map(&(&1 * &1))
|> Enum.sum()
`,
  },
  {
    name: 'Maps and strings',
    code: `people = [
  %{name: "Ada", born: 1815},
  %{name: "Alan", born: 1912},
  %{name: "Grace", born: 1906}
]

people
|> Enum.sort_by(& &1.born)
|> Enum.map_join(", ", &"#{&1.name} (#{&1.born})")
`,
  },
  {
    name: 'Module and recursion',
    code: `defmodule Fib do
  def of(0), do: 0
  def of(1), do: 1
  def of(n) when n > 1, do: of(n - 1) + of(n - 2)
end

Fib.of(20)
`,
  },
  {
    name: 'Comprehensions',
    code: `pairs = for x <- 1..6, y <- 1..6, x + y == 7, do: {x, y}

{length(pairs), pairs}
`,
  },
  {
    name: 'An error (aborts the VM)',
    code: `IO.puts("about to fail")
raise "boom: this is an uncaught Elixir error"
`,
  },
];

const el = {
  editor: document.getElementById('editor'),
  examples: document.getElementById('examples'),
  run: document.getElementById('run'),
  clear: document.getElementById('clear'),
  status: document.getElementById('status'),
  duration: document.getElementById('duration'),
  progress: document.getElementById('progress'),
  progressText: document.getElementById('progress-text'),
  result: document.getElementById('result'),
  logs: document.getElementById('logs'),
};

let popcorn = null;
let running = false;

function setStatus(token, label, kind) {
  el.status.textContent = label;
  el.status.className = `badge ${kind}`;
  // Stable token for scripted checks, separate from the human-facing label.
  document.documentElement.dataset.status = token;
}

function log(text, kind) {
  const span = document.createElement('span');
  span.className = kind;
  // The VM emits stdout line by line with the newline stripped.
  span.textContent = text.endsWith('\n') ? text : `${text}\n`;
  el.logs.appendChild(span);
  el.logs.scrollTop = el.logs.scrollHeight;
}

function describeError(error) {
  if (typeof error === 'string') {
    if (error === 'Promise timeout') return TIMEOUT_MESSAGE;
    if (error.startsWith('Call cancelled')) return RELOADED_MESSAGE;
    return error;
  }
  if (error && typeof error === 'object') {
    if (error.error !== undefined) return describeError(error.error);
    if (error.message) return error.message;
  }
  return String(error);
}

function describeBootError(error) {
  const message = describeError(error);
  return message === TIMEOUT_MESSAGE ? BOOT_TIMEOUT_MESSAGE : message;
}

function loadExample(index) {
  el.editor.value = EXAMPLES[index].code;
  el.examples.value = String(index);
}

async function boot({ announce = true } = {}) {
  const started = performance.now();
  popcorn = await Popcorn.init({
    bundlePath: 'wasm/bundle.avm',
    wasmDir: './wasm/',
    debug: true,
    onStdout: (text) => log(text, 'stdout'),
    onStderr: (text) => log(text, 'stderr'),
  });
  const bootMs = Math.round(performance.now() - started);
  document.documentElement.dataset.bootMs = String(bootMs);
  el.progress.hidden = true;
  if (announce) {
    el.run.disabled = false;
    el.duration.textContent = `booted in ${(bootMs / 1000).toFixed(1)} s`;
    setStatus('ready', 'ready', 'ok');
  }
}

/** A timed-out instance is dead; the only way back is a fresh one. */
async function restartRuntime() {
  const previous = popcorn;
  popcorn = null;
  el.progress.hidden = false;
  el.progressText.textContent = 'Restarting the runtime…';
  try {
    previous?.deinit();
  } catch {
    // Already torn down by the heartbeat reload — nothing to do.
  }
  await boot({ announce: false });
}

async function run() {
  if (!popcorn || running) return;

  const code = el.editor.value.trim();
  if (code === '') return;

  running = true;
  el.run.disabled = true;
  el.logs.replaceChildren();
  el.result.replaceChildren();
  el.result.classList.remove('error');
  el.duration.textContent = '';
  setStatus('running', 'evaluating…', 'busy');

  const started = performance.now();
  try {
    const { data, durationMs } = await popcorn.call([EVAL_ELIXIR, code], {
      timeoutMs: EVAL_TIMEOUT_MS,
    });
    el.result.textContent = data === null || data === undefined ? '' : String(data);
    setStatus('done', 'done', 'ok');
    el.duration.textContent = `${Math.round(durationMs)} ms`;
  } catch (error) {
    el.result.textContent = describeError(error);
    el.result.classList.add('error');
    el.duration.textContent = `${Math.round(performance.now() - started)} ms`;
    setStatus('error', 'error', 'err');
    try {
      await restartRuntime();
      setStatus('error', 'error — runtime restarted', 'err');
    } catch (restartError) {
      el.result.textContent += `\n\nCould not restart the runtime: ${describeError(restartError)}`;
      setStatus('failed', 'restart failed', 'err');
    }
  } finally {
    running = false;
    el.run.disabled = false;
    document.documentElement.dataset.runs = String(
      Number(document.documentElement.dataset.runs ?? 0) + 1,
    );
  }
}

EXAMPLES.forEach((example, index) => {
  el.examples.append(new Option(example.name, String(index)));
});

el.examples.addEventListener('change', () => loadExample(Number(el.examples.value)));
el.run.addEventListener('click', run);
el.clear.addEventListener('click', () => {
  el.logs.replaceChildren();
  el.result.replaceChildren();
  el.result.classList.remove('error');
  el.duration.textContent = '';
});
el.editor.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    run();
  }
});

loadExample(0);

boot().catch((error) => {
  el.progress.hidden = true;
  el.progressText.textContent = 'Boot failed';
  el.result.textContent = describeBootError(error);
  el.result.classList.add('error');
  setStatus('failed', 'boot failed', 'err');
});
