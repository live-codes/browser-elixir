# Spike findings — Elixir and Erlang in the browser

**Status: spike complete.** The page boots AtomVM from a mirrored runtime, evaluates Elixir and
Erlang, streams `stdout`/`stderr`, reports `inspect/1` of the result, and recovers when the VM
aborts. Everything below was **run**, in headless Chrome — not inferred from docs.

Runtime provenance, the mirror pin and the hashes are in [WASM.md](WASM.md).

## 1. The trap: the runtime and the bundle are version-locked

Popcorn's JavaScript bridge and its `.avm` bundle speak a private protocol, and the two must come
from the same build. This cost the most time to establish, so it is recorded first.

- The bundle here speaks the older handshake: the parent sends `popcorn-init` / `popcorn-startVm`,
  and Elixir calls `Popcorn.Wasm.register/1`, which lands in the iframe as `Module.onElixirReady`.
  Stack traces from this bundle show `Elixir.Popcorn.Wasm.handle_message!/2` and
  `Elixir.EvalInWasm.handle_wasm/2` — a 0.3-era API, not the current one.
- Every published `@swmansion/popcorn` (checked **0.2.2, 0.3.0, 0.3.3**) ships a refactored
  runtime instead: `dist/iframe.mjs` + `dist/popcorn.mjs`, a **4.1–4.2 MB debug `AtomVM.wasm`**,
  and a `Popcorn.Wasm.ready/0,1` + `set_default_receiver/1` handshake over a `popcorn-event`
  channel. The 0.3.3 `iframe.mjs` never sends `popcorn-init`, and waits for a `ready/0` this
  bundle never calls — so `Popcorn.init()` would hang until its 30 s timeout.

Hence: **keep a matched set, or rebuild the bundle to match the runtime you pin.** This also means a
mirror serves *binaries only* — the scripts are pinned in-repo so the halves cannot drift apart.

## 2. The reply shape is not the documented one

The current `EvalInWasm` example replies with a map (`%{value: inspect(...)}` /
`%{error: Exception.message(...)}`). **This bundle replies with the inspected value itself.** The
raw `onCall` traces from the page console:

```
[debug] Main: onCall:  {requestId: 0, error: undefined, data: ":ok"}
[debug] Main: onCall:  {requestId: 1, error: undefined, data: "220"}
[debug] Main: onCall:  {requestId: 2, error: undefined, data: ""Ada (1815), Grace (1906), Alan (1912)""}
[debug] Main: onCall:  {requestId: 3, error: undefined, data: "6765"}
[debug] Main: onCall:  {requestId: 4, error: undefined, data: "{6, [{1, 6}, {2, 5}, {3, 4}, {4, 3}, {5, 2}, {6, 1}]}"}
```

A driver that assumes `data.value` throws `Cannot use 'in' operator …` on every success. `data` is
already a string.

## 3. Verified working — Elixir

Run in the browser, one after another, against a single booted instance.

| snippet | result | time |
| --- | --- | --- |
| `IO.puts("Hello from Elixir!")` | stdout `Hello from Elixir!`; value `:ok` | 6 ms |
| `1..10 \|> Enum.filter(&(rem(&1, 2) == 0)) \|> Enum.map(&(&1 * &1)) \|> Enum.sum()` | `220` | 13 ms |
| `people \|> Enum.sort_by(& &1.born) \|> Enum.map_join(", ", &"#{&1.name} (#{&1.born})")` | `"Ada (1815), Grace (1906), Alan (1912)"` | 23 ms |
| `defmodule Fib do … end` then `Fib.of(20)` | `6765` | 352 ms |
| `for x <- 1..6, y <- 1..6, x + y == 7, do: {x, y}` | `{6, [{1, 6}, {2, 5}, {3, 4}, {4, 3}, {5, 2}, {6, 1}]}` | 23 ms |
| `try do raise "boom" rescue e -> {:caught, Exception.message(e)} end` | `{:caught, "boom"}` | 8 ms |
| `1 + 2 * 3`, `1.5 + 1.5`, `7 / 2` | `7`, `3.0`, `3.5` | 2–3 ms |
| `Enum.map([1, 2, 3], &(&1 * 2))`, `Enum.chunk_every([1, 2, 3, 4, 5], 2)` | `[2, 4, 6]`, `[[1, 2], [3, 4], [5]]` | 4 ms |
| `String.upcase("hello") <> "!"`, `Map.new([{:a, 1}, {:b, 2}])` | `"HELLO!"`, `%{a: 1, b: 2}` | 4–6 ms |
| `IO.inspect([1, 2, 3])` | stdout `[1, 2, 3]`; value `[1, 2, 3]` | 3 ms |
| `spawn(fn -> send(parent, :ping) end)` + `receive` | `:ping` | 7 ms |
| `:ets.new(:t, [])` | `#Reference<0.0.95>` | 4 ms |
| `:crypto.hash(:sha256, "abc")` | `<<186, 120, 22, 191, …>>` — byte-for-byte `sha256("abc")` | 3 ms |

`Fib.of(20)` at ~350 ms is the naive double recursion being interpreted — ~25× a typical `Enum`
call. Worth knowing for anything compute-shaped.

## 4. Verified working — Erlang

The eval app registers **three** actions, not one: `eval_elixir`, `eval_erlang`, and
`eval_erlang_module`. All three exist in this bundle, and the flag for which one to send is the
caller's: upstream sniffs a leading `-module(`.

| snippet (`eval_erlang`) | result | time |
| --- | --- | --- |
| `1 + 1.` | `2` | 3 ms |
| `lists:sum([1, 2, 3, 4]).` | `10` | 3 ms |
| `lists:sort([3, 1, 2]).`, `length([a, b, c]).` | `[1, 2, 3]`, `3` | 3 ms |
| `element(2, {a, b, c}).` | `:b` | 5 ms |
| `maps:get(k, #{k => 42}).` | `42` | 3 ms |
| `Fun = fun(X) -> X * X end, Fun(7).` | `49` | 4 ms |
| `lists:foldl(fun(X, Acc) -> X + Acc end, 0, [1, 2, 3, 4, 5]).` | `15` | 5 ms |
| `self().`, `spawn(fun() -> 1 end).` | `#PID<0.25.0>`, `#PID<0.26.0>` | 3 ms |
| `try 1 / 0 catch error:Reason -> Reason end.` | `:badarith` | 4 ms |

**Module compilation works too** — so the Erlang compiler (`:compile`) is in the bundle, not just
Elixir's. These ran through the page itself (`eval_erlang_module`, then `eval_erlang` in the same
session):

| snippet | result | time |
| --- | --- | --- |
| `-module(m). -export([double/1]). double(X) -> X * 2.` | `:m` | 42 ms |
| `m:double(21).` | `42` | 1 ms |
| `[{X, Y} \|\| X <- lists:seq(1, 6), Y <- lists:seq(1, 6), X + Y =:= 7].` | the six pairs | 7 ms |
| `lists:sum(lists:map(fun(X) -> X * X end, lists:seq(1, 10))).` | `385` | 10 ms |
| `M0 = #{a => 1}, M1 = maps:put(b, 2, M0), maps:to_list(M1).` | `[a: 1, b: 2]` | 3 ms |
| `Parent = self(), spawn(…), receive {_From, Result} -> Result end.` | `42` | 7 ms |

Compiled modules persist for the session (`:code.load_binary`) and survive a language switch — so
`m:double(21).` works after you have run the module example once. That is also why the examples
ship as a pair: define, then call.

**Two Erlang-specific quirks, both found by running the examples:**

1. **A comment on the module's first line breaks compilation.** This snippet fails:
   ```erlang
   %% a comment
   -module(m).
   -export([double/1]).
   ```
   with `{:error, {3, :erl_parse, ['syntax error before: ', '-']}}` — the error points at
   `-export`, the second form. The same comment after `-module(m).` compiles fine. The bundle's
   `split_forms` chunks tokens on `{:dot, _}` before handing each chunk to `:erl_parse.parse_form`,
   and a comment preceding the first attribute apparently lands in the wrong chunk. Workaround:
   keep comments off the first line.

2. **Erlang parse errors are values, not crashes** — see §5.

Results are formatted with Elixir's `inspect/1` either way, because the eval server is an Elixir
GenServer — hence `:b`, `[a: 1, b: 2]` and `:badarith` rather than `b`, `[{a,1},{b,2}]`,
`badarith`.

## 5. How errors behave — and the Elixir/Erlang asymmetry

An uncaught Elixir error is **not** reported as an error. The sequence, from the page console:

```
[debug] Main: call:  {requestId: 7, …}
[debug] Main: onCallAck:  {requestId: 7}
                       ← nothing further; the VM is dead
[error] Runtime VM crashed, popcorn iframe reloaded.
[debug] Main: reloading iframe → deinit → mount
```

The call is acknowledged and then never answered, so the client waits out its timeout (15 s here,
30 s by default). The *next* call is what discovers the corpse: it gets `noproc`, which triggers an
iframe reload, and that reload cancels the pending call with
`Call cancelled due to instance deinit`. **One run is lost to the reload**, which is why
`public/main.js` restarts the VM itself as soon as a call times out — verified: after the error
example, the next run returned `220` in 10 ms.

Erlang behaves differently, and better: `:erl_scan`/`:erl_parse` failures are returned as ordinary
values. `lists:sum([1, 2, 3, 4])` with no final dot yields
`{:error, {1, :erl_parse, ['syntax error before: ', []]}}` in 3 ms — status `done`, no restart.

**`try`/`rescue` works** (Elixir), verified four ways — `raise` → `"boom"`; `div(1, 0)` →
`"bad argument in arithmetic expression"`; `Foo.bar()` →
`"function :elixir.eval_external_handler/3 is undefined or private"` (AtomVM naming an internal,
which is a diagnostics-quality datapoint in itself); and Erlang's `try … catch error:Reason`.

What cannot be caught in either language: **compile errors and missing NIFs**. They abort the VM
below the `try`.

A driver-level improvement worth making during LiveCodes integration is to wrap Elixir source so
ordinary runtime errors come back as a value instead of a 15 s hang and a restart:

```elixir
try do
  <user code>
rescue
  e -> {:error, Exception.message(e)}
end
```

It will not rescue compile errors or missing NIFs, so the timeout-and-restart path has to stay. It
was left out of the PoC so the raw behaviour remains visible.

## 6. Capability matrix — what a user will hit

| probe | outcome |
| --- | --- |
| `Regex.match?(~r(ab), ~s(xabc))` | **VM abort.** `Nif not found` → `binary:list_to_bin/1` → crash dump → `Aborted()` |
| `DateTime.utc_now()` | **VM abort.** `Nif not found` → `os:system_time/0` |
| `Task.async(fn -> 42 end) \|> Task.await()` | **VM abort.** `Nif not found` → `erlang:monitor/3` |
| `Float.round(1.25, 1)` | **VM abort, silently** — no reply and no diagnostic at all |
| `defmodule P do defstruct [:name] end` + `%P{name: "Ada"}` | **VM abort.** Compile error on stderr: `EvalInWasm.P.__struct__/1 is undefined, cannot expand struct EvalInWasm.P` |
| a syntax error, or an uncaught `raise` | **VM abort** |
| Erlang module with a leading `%%` comment | error tuple (not fatal) — see §4 |

Two patterns explain the fatal ones: **a missing NIF is a hard abort**, and **a compile-time failure
happens before any `try` in the evaluated string can run**. Notably, `defmodule` works for *function
calls* (`Fib.of(20)`) but not for *struct literals* in the same eval — because
`Code.eval_string/3` is called with the host module's `__ENV__`, so `defmodule P` really defines
`EvalInWasm.P`.

### The 16 MiB heap ceiling (most likely cause of the `memory access out of bounds`)

The build allocates its shared memory with `initial === maximum`:

```js
var INITIAL_MEMORY = Module["INITIAL_MEMORY"] || 16777216;   // 16 MiB
wasmMemory = new WebAssembly.Memory({
  initial: INITIAL_MEMORY / 65536,
  maximum: INITIAL_MEMORY / 65536,
  shared: true,
});
```

so the heap is fixed at 16 MiB and can never grow. A 7 MB bundle, the Elixir/Erlang compilers and
every module a session defines all share it — and exceeding it surfaces as
`memory access out of bounds` inside a pthread worker.

It cannot be raised from JavaScript. Passing `INITIAL_MEMORY: 256 * 1024 * 1024` fails at
instantiation, because the limit is baked into the compiled module as well:

```
wasm streaming compile failed: LinkError: WebAssembly.instantiate(): Import #96 "a" "a": …
```

Lifting it needs a rebuilt AtomVM (a larger initial memory, or memory growth enabled) — not a
configuration change. Until then the practical mitigations are the ones already in the driver: the
VM aborts cleanly and is restarted, and a run that dies is not silently ignored.

## 7. Cross-origin isolation is mandatory (measured, both ways)

Served the identical page with and without COOP/COEP:

| headers | `crossOriginIsolated` | `typeof SharedArrayBuffer` | outcome |
| --- | --- | --- | --- |
| `COOP: same-origin` + `COEP: require-corp` | `true` | `function` | boots; run returns `220` |
| `COOP: same-origin` + `COEP: credentialless` | `true` | `function` | boots; run returns `220` |
| none (`--no-isolation`) | `false` | `undefined` | **`Popcorn.init()` never returns**; boot times out |

**Mechanism.** The build is compiled with pthreads and Emscripten gates threading on the presence of
the global:

```js
var _emscripten_has_threading_support = () => !!globalThis.SharedArrayBuffer;
var ___pthread_create_js = (…) => { if (!_emscripten_has_threading_support()) { return 6 } … };  // 6 = EAGAIN
```

Without isolation the `SharedArrayBuffer` global is hidden, `pthread_create` returns EAGAIN, and
AtomVM's startup — which needs a thread — never completes, so `init` resolves only on timeout.

Worth correcting an earlier reading in this file: the platform does **not** refuse to *allocate* the
shared memory outside isolation. Probed directly, `new WebAssembly.Memory({ shared: true, … })`
still succeeds and its buffer's constructor is `SharedArrayBuffer`; only the global constructor is
hidden. So the gate is Emscripten's check, not a hard platform block.

**Consequence for mirrors.** Because the runtime is now fetched cross-origin, `require-corp` means
the mirror has to be opt-in for embedding — jsDelivr sends `Cross-Origin-Resource-Policy:
cross-origin` *and* `Access-Control-Allow-Origin: *`, and `raw.githubusercontent.com` sends CORS, so
both work (verified). A mirror that sends neither would be blocked by `require-corp` but allowed
under `credentialless`, which therefore is the safer default if the mirror is ever self-hosted.
`serve.js` exposes both (`--credentialless`).

`boot()` in `public/main.js` names this cause explicitly, because the symptom is a bare timeout.

**Can the requirement be avoided?** Not with this bundle. Two routes were measured, both dead ends:

| attempt | outcome |
| --- | --- |
| no COOP/COEP at all | **no error anywhere** — `startPopcorn()` never settles, so the VM simply never becomes ready. Emscripten's `pthread_create` returns EAGAIN and AtomVM never surfaces it, so there is nothing to catch and the only signal is the client timeout. |
| recover `SharedArrayBuffer` at runtime | Gets *further*: the gate is satisfied and the pthread worker is really spawned — then the worker dies with `Uncaught TypeError: __emscripten_thread_crashed is not a function`. |

The second is worth recording because it looks so promising: outside COI the browser still hands out
a **real** shared `WebAssembly.Memory` (its buffer's constructor is `SharedArrayBuffer`), so
`new WebAssembly.Memory({shared:true}).buffer.constructor` recovers the global and satisfies
`!!globalThis.SharedArrayBuffer`. It is not enough — this build's worker path expects wiring that
only exists in a genuine threading context — so **no runtime trick removes the requirement.**

The durable fix is a build without the pthread path (AtomVM compiled single-threaded), which is a
build-time change needing the Emscripten SDK plus the AtomVM/FissionVM source. Whether upstream
exposes such a target has not been checked here, so treat that as the open question rather than a
plan.

## 8. Hosting the runtime on a CDN

The runtime is fully mirrored. What made that hard was the pthread worker: Emscripten spawns it
from the runtime module's own URL.

```js
allocateUnusedWorker() {
  if (Module["mainScriptUrlOrBlob"]) { … new Worker(pthreadMainJs, {type:"module", name:"em-pthread"}) }
  else worker = new Worker(new URL("AtomVM.mjs", import.meta.url), {type:"module", name:"em-pthread"});
}
```

This build uses **pthreads** — which is exactly why it needs `SharedArrayBuffer`, and therefore why
cross-origin isolation is mandatory (§7). Those threads are workers, and workers must be
same-origin, so a cross-origin `AtomVM.mjs` throws a `SecurityError` that is swallowed. Measured
with the same page, the same bundle and the same headers, varying only the script origin:

| script origin | outcome |
| --- | --- |
| same-origin | boots in 176 ms; bundle still fetched from jsDelivr |
| jsDelivr | `INIT` fires, then nothing — boot times out after 30 s, no error logged |

The worker traffic is visible in the network log as repeated `GET /wasm/AtomVM.mjs (Script)`
requests after boot: that is the em-pthread pool spawning from the module's own URL.

Emscripten's `Module.mainScriptUrlOrBlob` lifts the constraint: fetch the module from the mirror and
hand it back as a **Blob URL**, which is same-origin and has a usable base URL. That is what
`popcorn_iframe.js` does now, so `AtomVM.mjs` is mirrored too and the repo ships only the two
patched scripts (~20 KB).

Two things this cost, both worth recording:

- **It has to be the module itself.** The worker is created with `{ type: "module" }` (hardcoded by
  Emscripten), and `importScripts` does not exist in a module worker — so the usual
  `toDataUrl('importScripts("…")')` helper, which is for *classic* workers, cannot be used here.
- **Blob, not `data:`.** Tested both against the real module: `import(dataUrl)` and
  `new Worker(dataUrl, {type:'module'})` each work in isolation in the top frame, but a data-URL
  worker running the *runtime* starts and then aborts with an empty reason:

  ```
  Aborted()
  worker sent an error! Uncaught RuntimeError: Aborted(). Build with -sASSERTIONS for more info.
  ```

  A Blob URL boots in ~350 ms. The reading: a `data:` URL has no origin and no hierarchical base, so
  `scriptDirectory` is unresolvable inside the worker, whereas `blob:http://…` is same-origin.
  (That error string is also why the data-URL experiment was so opaque at first: the whole data URL
  is echoed as the worker's `filename`, so the actual message sits ~200 KB into the line.)

**A caching lesson paid for in debugging time:** `serve.js` originally marked all of `/wasm/*`
`immutable` for a year. A stale cached `popcorn.js` silently kept the *unpatched* bundle path, and
the failure looked like a CDN problem (`GET /https://cdn.jsdelivr.net/…/bundle.avm 404`). Only
pinned binaries are cached hard now; scripts are `no-store`.

## 9. Boot cost and payload

| | |
| --- | --- |
| `bundle.avm` — mirror | 7,114,092 B |
| `AtomVM.wasm` — mirror | 997,332 B |
| `AtomVM.mjs` — mirror | 149,754 B |
| patched scripts in this repo (`popcorn.js`, `popcorn_iframe.js`) | 20,543 B |
| **runtime total** | **~8.3 MB, of which 20 KB is committed** |
| boot, binaries warm | 116–348 ms |
| boot, binaries cold from jsDelivr | 1,163 ms |

Everything except the two scripts is fetched from the mirror once and cached; the scripts ship with
the page. Boot times are measured on loopback, so a cold network fetch of 8.1 MB is not represented.

## 10. Recommendation for LiveCodes

- **`lang-elixir` / `lang-erlang`**: identity compiler factory;
  `scripts: [baseUrl + '{{hash:lang-elixir-script.js}}']`; `scriptType: 'text/elixir'` (and
  `'text/erlang'`); `compiledCodeLanguage: 'elixir'` / `'erlang'`; `largeDownload: true`. The result
  page becomes the parent of Popcorn's iframe, which is the model this PoC already uses. Both
  languages share one VM, so they can share one runtime.
- **Two blockers to settle first.** (1) The isolation requirement: Popcorn's iframe is created
  *inside* the result iframe, so the top-level document's headers decide whether
  `SharedArrayBuffer` exists — and when LiveCodes is embedded via CDN those headers are not ours.
  (2) The same-origin script constraint from §8, which rules out the usual "put it on jsDelivr"
  hosting for `AtomVM.mjs`. Either the result page is served cross-origin isolated with the scripts
  same-origin, or the runtime needs an AtomVM build without the pthread path. Popcorn 0.4 requires
  the same headers, so this outlives 0.3.
- **Hosting**: the two binaries belong in `browser-compilers` (or an npm package) and referenced
  from `vendors.ts`; the three scripts belong with the language module.
- **Contract mapping**: stdout/stderr come from `onStdout`/`onStderr`; the inspected value is the
  result; `exitCode` is ours to define (`0` on success, `1` on abort/timeout), and the timeout is
  load-bearing rather than exceptional.
- **No stdin**, so both languages are eval-shaped: no competitive-programming-style input.

## 11. Provenance notes

Diagnostics from the bundle leak its build machine:
`/Users/yamauchi/repos/popcorn/examples/eval_in_wasm/lib/eval_in_wasm.ex`. Combined with the
`Popcorn.Wasm` / `handle_wasm/2` API shape, that dates the bundle to a 0.3-era checkout of Popcorn's
own eval example — consistent with it being a redistribution of that example's output, built with
OTP 26.0.2 / Elixir 1.17.3. Provenance, the mirror pin and the hashes are in
[WASM.md](WASM.md).

## 12. Reproducing the verification

```bash
npm start                     # → http://localhost:8125/
npm run check                 # syntax-check serve.js, public/main.js and the patched scripts
npm run start:credentialless  # isolated via COEP: credentialless — also boots
npm run start:no-isolation    # then reload → boot fails; proves §7
```

Driven here with the `agent-browser` CLI against headless Chrome: select the language and example,
click Run, and read `document.documentElement.dataset.status` (`booting` / `ready` / `running` /
`done` / `error` / `failed`), `dataset.language`, `dataset.bootMs` and `dataset.runs`, plus the
`#result` and `#logs` panes. One Windows-specific gotcha, recorded because it cost real time:
PowerShell 5.1 strips embedded double quotes from native-command arguments, so `eval` scripts must
avoid string literals entirely — the page's element ids are exposed as globals (`result`, `logs`,
`editor`, `examples`, `run`), which is what the probes used.

A cleaner way to feed those probes, found later: write the script to a file and pipe it in —
`type probe.js | agent-browser eval --stdin` — which sidesteps shell quoting entirely. Probes that
take longer than the CDP call timeout must be started without awaiting (fire, then read results
back from a global), or the whole eval is discarded as `CDP command timed out`.

## 13. `stdin` and exit codes, mocked in the driver

Added after the spike, and measured the same way: headless Chrome, against the pinned runtime.

**`IO.gets` is fatal as shipped.** The runtime's own group leader never answers `get_line`, so the
call is never answered at all.

| probe | result | time |
| --- | --- | --- |
| `IO.gets("")`, no device installed | **no reply** — timeout, then the instance is restarted | 15,409 ms |

The fix is to answer it ourselves. The driver installs its own IO device with
`Process.group_leader/2`, serving `get_line` from a list of lines and forwarding `put_chars` to the
real stdout. A device built out of `StringIO` also works — both were built — but it swallows stdout
into its own buffer, so output stops streaming; the pass-through device keeps it live and ships.

| probe | result | time |
| --- | --- | --- |
| `IO.gets("")` against an empty device | `:eof` | 60 ms |
| two reads, `?stdin=Ada%0A42` | `"Ada\n"` then `"42\n"` → `43` | 51 ms |
| a third read, input exhausted | `:eof` | 58 ms |
| `IO.puts` with the device installed | reaches the page **mid-run**: `FIRST` at 207 ms, run ended at 2,110 ms | — |

**The device must be named with an atom.** `defmodule LcIo` defines `EvalInWasm.LcIo`, and `LcIo`
resolves to it only inside the *same* eval; a later eval looks for `Elixir.LcIo`, finds nothing and
aborts the VM (measured: a 15 s timeout and a restart). `defmodule :livecodes_io` resolves from any
eval, and one definition per instance is enough — ~1.7 s at boot, ~50 ms per run — so it is paid in
`boot()`. The same trap is why the wrapper must call `:livecodes_io.start/1`, not `LcIo.start/1`.

The atom name also buys the thing worth having: **one device serves both languages.** It is an
ordinary BEAM module, so Erlang reaches it as `livecodes_io:start/1` and there is no second
implementation to keep in step. The name is reserved the hard way, and that is why it is not
something as guessable as `lc_io`: a module of the *same* name compiled from the editor replaces the
device, and every run after it dies on the timeout — `-module(lc_io)` against the earlier name did
exactly that.

**Erlang runs are wrapped too**, in Erlang: the dot that ends a script is stripped before the code is
spliced into a `try`, and `catch` starts on its own line so a trailing `%` comment cannot swallow it.

| probe (Erlang) | result | time |
| --- | --- | --- |
| `io:format("hello~n").` | stdout `hello`, exit `0` | 61 ms |
| `io:get_line("")` twice, `?stdin=Ada%0A42` | `"Ada\n"`, `"42\n"` | 58 ms |
| a third read, input exhausted | `eof` | 66 ms |
| `1/0.` | exit `1`, result `{:error, :badarith}` — no restart | 51 ms |
| `erlang:halt(3).` | exit `3` | 55 ms |
| `lists:sum([1, 2, 3, 4]).` | `10`, exit `0` | 63 ms |

**Exit codes are the driver's and the wrapper's.**

| probe | exit code | note |
| --- | --- | --- |
| `IO.puts("hi")` | `0` | the wrapper returns the script's value |
| `raise "boom"` | `1` | `rescue` turns it into `{:lc_error, message}` — no restart, 55 ms |
| `System.halt(3)` / `erlang:halt(3).` | `3` | the run rewrites both to `:livecodes_io.halt/1` |
| a program that never answers | `124` | the timeout, and the instance is restarted |

`System.halt/1` cannot be supported as written. It calls `erlang:halt/1`, which is a **missing NIF**,
so it prints a crash dump on stderr and aborts — and it **cannot be caught**, because the abort
happens below any `try`:

```
Nif not found
nif_not_found_error raised, printing crash dump and aborting
… [{erlang,halt,2,…},{erlang,halt,1,…},{elixir,eval_external_handler,3,…}] …
Aborted()
```

That abort is fast rather than slow (409 ms, surfacing as `Call cancelled due to instance deinit`),
but it is still a dead VM. So the run rewrites `System\.halt(` and `erlang:halt(` to
`:livecodes_io.halt/1` — which throws and *is* caught by the wrapper (`throw({:lc_exit, 3})`
round-trips, 60 ms).

Two things neither wrapper rescues, because they abort below it: a **compile error** and a
**missing NIF**.

**One abort that was never explained.** The first attempt at an Erlang device module —
`-module(lc_io)`, four functions, a `receive` and a fun — aborted the VM with no diagnostic at all.
It was set aside for the Elixir module above (which turned out to be the better design anyway) and
the cause was never isolated. What the later bisect did establish is that the *same text* compiles
now, in ~1 s, and that each construct in it is individually fine: a two-function module, a
`spawn(fun …)` with a `receive`, `io:put_chars`, and a function named `halt/1` next to the
auto-imported BIF all compile. So it is recorded as a single unreproduced abort rather than a
limitation — with the caveat that Erlang compile failures abort silently, which is what makes it
expensive to chase.

Redefinition is *not* a problem in either language: `-module(m5)` defined twice in a row returns
`:m5` both times, and the wrappers leave loaded modules usable — `m2:double(21).` → `42`, a
two-function `m3` → `3`, and `lists:sum([1, 2, 3, 4]).` → `10`.

