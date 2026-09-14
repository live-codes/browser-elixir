import { Popcorn } from './wasm/popcorn.js';

/**
 * Runs Elixir and Erlang in the browser through Popcorn/AtomVM.
 *
 * The runtime (AtomVM wasm + the eval bundle) is loaded from a CDN mirror of
 * `live-codes/elixir-browser-eval`, pinned to a commit. Override the mirror with
 * `?baseUrl=https://…/` — it may be absolute or relative to this page.
 *
 * Three runtime behaviours shape the code below, all verified against this exact
 * bundle rather than assumed:
 *
 *   - A successful call resolves with the *inspected value itself* (older bundle
 *     shape: `inspect/1` of the last expression, as a string), not an object.
 *   - An uncaught error **aborts the VM**. The call is acknowledged and then
 *     never answered, so it surfaces as a client-side timeout, and the next
 *     call's `noproc` triggers an iframe reload. A timeout therefore means the
 *     instance is dead, and the driver restarts it rather than reusing it.
 *   - One VM serves all three actions (`eval_elixir`, `eval_erlang`,
 *     `eval_erlang_module`), so switching language needs no reboots.
 */

const DEFAULT_BASE_URL =
  'https://cdn.jsdelivr.net/gh/live-codes/elixir-browser-eval@6b354dab35fb7454ba2812f935b52b398ca1bec8/';

// An error and a long-running program are indistinguishable here — neither
// replies — so this only decides how long the UI waits before giving up.
const EVAL_TIMEOUT_MS = 15_000;

const TIMEOUT_MESSAGE =
  `No reply within ${EVAL_TIMEOUT_MS / 1000} s, so the runtime has stopped. An uncaught error ` +
  'aborts the VM, and a program that loops forever never answers. The runtime has been ' +
  'restarted — run again.';

const RELOADED_MESSAGE =
  'The runtime restarted mid-run (an earlier program aborted it). Run again.';

// `init` hanging is the signature of a document that is not cross-origin
// isolated — verified by serving the same page with and without COOP/COEP.
const BOOT_TIMEOUT_MESSAGE =
  'The runtime did not start. This page must be served cross-origin isolated: ' +
  'Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp ' +
  '(serve.js sets both). Without them SharedArrayBuffer is unavailable and AtomVM cannot boot.';

const LANGUAGES = {
  elixir: {
    label: 'Elixir',
    filename: 'main.exs',
    defaultAction: 'eval_elixir',
    note:
      "Elixir is <em>evaluated</em>, not run as a script: the last expression's value is " +
      'returned, so <code>IO.gets</code> has no input to read.',
    examples: [
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
        name: 'Try / rescue',
        code: `try do
  raise "boom"
rescue
  e -> {:caught, Exception.message(e)}
end
`,
      },
      {
        name: 'An uncaught error (aborts the VM)',
        code: `IO.puts("about to fail")
raise "boom: this is an uncaught Elixir error"
`,
      },
    ],
  },
  erlang: {
    label: 'Erlang',
    filename: 'main.erl',
    defaultAction: 'eval_erlang',
    moduleAction: 'eval_erlang_module',
    note:
      'Erlang expressions are comma-separated and must end with a dot. Code starting with ' +
      '<code>-module(</code> is compiled and loaded, so it stays callable in later runs.',
    examples: [
      {
        name: 'Hello world',
        code: `io:format("Hello from Erlang!~n"),
io:format("Same VM, same tab, no server.~n").
`,
      },
      {
        name: 'Lists and higher-order funs',
        code: `lists:sum(lists:map(fun(X) -> X * X end, lists:seq(1, 10))).
`,
      },
      {
        name: 'Maps',
        code: `M0 = #{a => 1},
M1 = maps:put(b, 2, M0),
maps:to_list(M1).
`,
      },
      {
        name: 'Processes',
        code: `Parent = self(),
spawn(fun() -> Parent ! {self(), 6 * 7} end),
receive {_From, Result} -> Result end.
`,
      },
      {
        name: 'List comprehension',
        code: `[{X, Y} || X <- lists:seq(1, 6), Y <- lists:seq(1, 6), X + Y =:= 7].
`,
      },
      {
        name: 'Module (run it, then run m:double(21).)',
        // No leading comment: this bundle's form splitter chokes on a comment
        // before the first attribute (see FINDINGS.md).
        code: `-module(m).
-export([double/1]).

double(X) -> X * 2.
`,
      },
      {
        name: 'Missing the final dot (returns a parse error)',
        code: `lists:sum([1, 2, 3, 4])
`,
      },
    ],
  },
};

function resolveBaseUrl() {
  const override = (new URLSearchParams(location.search).get('baseUrl') ?? '').trim();
  const base = override === '' ? DEFAULT_BASE_URL : override;
  return { baseUrl: base.endsWith('/') ? base : `${base}/`, isOverride: override !== '' };
}

const { baseUrl, isOverride } = resolveBaseUrl();
const runtimeDir = `${baseUrl}wasm/`;

const el = {
  editor: document.getElementById('editor'),
  filename: document.getElementById('filename'),
  language: document.getElementById('language'),
  examples: document.getElementById('examples'),
  run: document.getElementById('run'),
  clear: document.getElementById('clear'),
  status: document.getElementById('status'),
  duration: document.getElementById('duration'),
  progress: document.getElementById('progress'),
  progressText: document.getElementById('progress-text'),
  result: document.getElementById('result'),
  logs: document.getElementById('logs'),
  footerNote: document.getElementById('footer-note'),
  runtimeUrl: document.getElementById('runtime-url'),
  runtimeOverride: document.getElementById('runtime-override'),
};

let popcorn = null;
let running = false;
let spec = LANGUAGES.elixir;

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
  const base = message === TIMEOUT_MESSAGE ? BOOT_TIMEOUT_MESSAGE : message;
  return `${base}\n\nRuntime mirror: ${baseUrl}`;
}

/** Erlang modules go down a different action than Erlang expressions. */
function actionFor(code) {
  return spec.moduleAction && code.startsWith('-module(') ? spec.moduleAction : spec.defaultAction;
}

function clearOutput() {
  el.logs.replaceChildren();
  el.result.replaceChildren();
  el.result.classList.remove('error');
  el.duration.textContent = '';
}

function loadExample(index) {
  el.editor.value = spec.examples[index].code;
  el.examples.value = String(index);
}

function setLanguage(id) {
  spec = LANGUAGES[id];
  document.documentElement.dataset.language = id;

  el.filename.textContent = spec.filename;
  el.footerNote.innerHTML = spec.note;
  el.language.value = id;

  el.examples.replaceChildren();
  spec.examples.forEach((example, index) => {
    el.examples.append(new Option(example.name, String(index)));
  });

  clearOutput();
  loadExample(0);
}

async function boot({ announce = true } = {}) {
  const started = performance.now();
  popcorn = await Popcorn.init({
    // The bundle path is the single source of truth for the mirror: the iframe
    // derives the runtime's location from it.
    bundlePath: `${runtimeDir}bundle.avm`,
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
  clearOutput();
  setStatus('running', 'evaluating…', 'busy');

  const started = performance.now();
  try {
    const { data, durationMs } = await popcorn.call([actionFor(code), code], {
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

Object.entries(LANGUAGES).forEach(([id, language]) => {
  el.language.append(new Option(language.label, id));
});

el.language.addEventListener('change', () => setLanguage(el.language.value));
el.examples.addEventListener('change', () => loadExample(Number(el.examples.value)));
el.run.addEventListener('click', run);
el.clear.addEventListener('click', clearOutput);
el.editor.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    run();
  }
});

el.runtimeUrl.textContent = runtimeDir;
el.runtimeOverride.textContent = isOverride ? '(from ?baseUrl)' : '(default)';
setLanguage('elixir');

boot().catch((error) => {
  el.progress.hidden = true;
  el.progressText.textContent = 'Boot failed';
  el.result.textContent = describeBootError(error);
  el.result.classList.add('error');
  setStatus('failed', 'boot failed', 'err');
});
