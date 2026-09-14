# Spike findings — Elixir in the browser

**Status: spike complete.** The page boots AtomVM, evaluates arbitrary Elixir, streams
`stdout`/`stderr`, reports `inspect/1` of the result, and recovers when the VM aborts. Everything
below was **run**, in headless Chrome, against the vendored bundle — not inferred from docs.

Artifacts under test: `public/wasm/` (hashes in [public/wasm/VERSION.md](public/wasm/VERSION.md)).

## 1. The trap: the runtime and the bundle are version-locked

Popcorn's JavaScript bridge and its `.avm` bundle speak a private protocol, and the two must come
from the same build. This cost the most time to establish, so it is recorded first.

- The bundle here speaks the older handshake: the parent sends `popcorn-init` / `popcorn-startVm`,
  and Elixir calls `Popcorn.Wasm.register/1`, which lands in the iframe as `Module.onElixirReady`.
  Stack traces from this bundle show `Elixir.Popcorn.Wasm.handle_message!/2` and
  `Elixir.EvalInWasm.handle_wasm/2` — i.e. a 0.3-era API, not the current one.
- Every published `@swmansion/popcorn` (checked **0.2.2, 0.3.0, 0.3.3**) ships a refactored
  runtime instead: `dist/iframe.mjs` + `dist/popcorn.mjs`, a **4.1–4.2 MB debug `AtomVM.wasm`**,
  and a `Popcorn.Wasm.ready/0,1` + `set_default_receiver/1` handshake over a `popcorn-event`
  channel. The 0.3.3 `iframe.mjs` never sends `popcorn-init`, and waits for a `ready/0` this
  bundle never calls — so `Popcorn.init()` would hang until its 30 s timeout.

Hence: **vendor a matched set, or rebuild the bundle to match the runtime you pin.** Do not mix a
CDN runtime with this bundle. The clean fix is to cook our own `bundle.avm` against
`@swmansion/popcorn@0.3.3` (Docker + `mise install` + `mix popcorn.cook`), after which the runtime
can be served from jsDelivr.

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

## 3. Verified working

Run in the browser, one after another, against a single booted instance.

| snippet | result | time |
| --- | --- | --- |
| `IO.puts("Hello from Elixir!")` | stdout `Hello from Elixir!`; value `:ok` | 7 ms |
| `1..10 \|> Enum.filter(&(rem(&1, 2) == 0)) \|> Enum.map(&(&1 * &1)) \|> Enum.sum()` | `220` | 9 ms |
| `people \|> Enum.sort_by(& &1.born) \|> Enum.map_join(", ", &"#{&1.name} (#{&1.born})")` | `"Ada (1815), Grace (1906), Alan (1912)"` | 25 ms |
| `defmodule Fib do … end` then `Fib.of(20)` | `6765` | 361 ms |
| `for x <- 1..6, y <- 1..6, x + y == 7, do: {x, y}` | `{6, [{1, 6}, {2, 5}, {3, 4}, {4, 3}, {5, 2}, {6, 1}]}` | 25 ms |
| `1 + 2 * 3` | `7` | 2 ms |
| `1.5 + 1.5`, `7 / 2` | `3.0`, `3.5` | 3 ms |
| `Enum.map([1, 2, 3], &(&1 * 2))` | `[2, 4, 6]` | 4 ms |
| `Enum.chunk_every([1, 2, 3, 4, 5], 2)` | `[[1, 2], [3, 4], [5]]` | 4 ms |
| `String.upcase("hello") <> "!"` | `"HELLO!"` | 4 ms |
| `Map.new([{:a, 1}, {:b, 2}])` | `%{a: 1, b: 2}` | 6 ms |
| `IO.inspect([1, 2, 3])` | stdout `[1, 2, 3]`; value `[1, 2, 3]` | 3 ms |
| `spawn(fn -> send(parent, :ping) end)` + `receive` | `:ping` | 7 ms |
| `:ets.new(:t, [])` | `#Reference<0.0.95>` | 4 ms |
| `:crypto.hash(:sha256, "abc")` | `<<186, 120, 22, 191, …>>` — byte-for-byte `sha256("abc")` | 3 ms |
| `try do raise "boom" rescue e -> Exception.message(e) end` | `"boom"` | 8 ms |

`Fib.of(20)` at 361 ms is the naive double recursion being interpreted — ~40× a typical
`Enum` call. Worth knowing for anything compute-shaped.

## 4. Capability matrix — what a user will hit

| probe | outcome |
| --- | --- |
| `Regex.match?(~r(ab), ~s(xabc))` | **VM abort.** `Nif not found` → `binary:list_to_bin/1` → crash dump → `Aborted()` |
| `DateTime.utc_now()` | **VM abort.** `Nif not found` → `os:system_time/0` |
| `Task.async(fn -> 42 end) \|> Task.await()` | **VM abort.** `Nif not found` → `erlang:monitor/3` |
| `Float.round(1.25, 1)` | **VM abort, silently** — no reply and no diagnostic at all |
| `defmodule P do defstruct [:name] end` + `%P{name: "Ada"}` | **VM abort.** Compile error on stderr: `EvalInWasm.P.__struct__/1 is undefined, cannot expand struct EvalInWasm.P` |
| a syntax error | **VM abort** |
| an uncaught `raise` | **VM abort** |

Two patterns explain all of it: **a missing NIF is a hard abort**, and **a compile-time failure
happens before any `try` in the evaluated string can run**. Notably, `defmodule` works for
*function calls* (`Fib.of(20)`) but not for *struct literals* in the same eval — because
`Code.eval_string/3` is called with the host module's `__ENV__`, so `defmodule P` really defines
`EvalInWasm.P`.

## 5. How errors behave (and how to make them bearable)

An uncaught error is **not** reported as an error. The sequence, from the page console:

```
[debug] Main: call:  {requestId: 7, …}
[debug] Main: onCallAck:  {requestId: 7}
                       ← nothing further; the VM is dead
[error] Runtime VM crashed, popcorn iframe reloaded.
[debug] Main: reloading iframe → deinit → mount
```

So the call is acknowledged and then never answered — the client waits out its timeout (set to
15 s here, 30 s by default). The *next* call is what discovers the corpse: it gets `noproc`, which
triggers an iframe reload, and that reload cancels the pending call with
`Call cancelled due to instance deinit`. **One run is lost to the reload**, which is why
`public/main.js` restarts the VM itself as soon as a call times out. Verified: after the error
demo, the next run returned `220` in 10 ms.

**`try`/`rescue` works**, verified three ways — `raise` → `"boom"`; `div(1, 0)` →
`"bad argument in arithmetic expression"`; `Foo.bar()` →
`"function :elixir.eval_external_handler/3 is undefined or private"` (AtomVM naming an internal,
which is a diagnostics-quality datapoint in itself).

That suggests a driver-level improvement worth making during LiveCodes integration: wrap the
user's source so ordinary runtime errors come back as a value instead of a 15 s hang and a
restart.

```elixir
try do
  <user code>
rescue
  e -> {:error, Exception.message(e)}
end
```

It will **not** rescue compile errors or missing NIFs — those abort the VM before or below the
`try` — so the timeout-and-restart path has to stay regardless. It was deliberately left out of
the PoC so the raw behaviour remains visible.

## 6. Cross-origin isolation is mandatory (measured, both ways)

Served the identical page with and without COOP/COEP:

| headers | `crossOriginIsolated` | `typeof SharedArrayBuffer` | outcome |
| --- | --- | --- | --- |
| `COOP: same-origin` + `COEP: require-corp` | `true` | `function` | boots; run returns `220` |
| none (`--no-isolation`) | `false` | `undefined` | **`Popcorn.init()` never returns**; boot times out |

Upstream's `_headers` is right, and the Emscripten build's conditional
(`_emscripten_has_threading_support = () => !!globalThis.SharedArrayBuffer`) is not a graceful
degradation in practice. `boot()` in `public/main.js` now names this cause explicitly, because the
symptom is a bare timeout.

## 7. Boot cost and payload

| | |
| --- | --- |
| `AtomVM.wasm` | 997,332 B |
| `bundle.avm` (contains the Elixir compiler) | 7,114,092 B |
| `AtomVM.mjs` + `popcorn.js` + `popcorn_iframe.js` | 168,818 B |
| **total** | **~8.3 MB** |
| boot (localhost, warm cache) | 116–227 ms |

Measured on loopback, so the 8.3 MB is not represented in those timings — on a real network the
download dominates. `serve.js` marks `/wasm/*` `immutable` for a year, which matters because
Popcorn recreates its iframe on every boot and on every heartbeat reload.

## 8. Recommendation for LiveCodes

- **`lang-elixir.ts`**: identity compiler factory; `scripts: [baseUrl + '{{hash:lang-elixir-script.js}}']`;
  `scriptType: 'text/elixir'`; `compiledCodeLanguage: 'elixir'`; `largeDownload: true`. The result
  page becomes the parent of Popcorn's iframe, which is the model this PoC already uses.
- **The isolation requirement is the blocker to resolve first.** Popcorn's iframe is created
  *inside* the result iframe, so the top-level document's response headers decide whether
  `SharedArrayBuffer` exists — and when LiveCodes is embedded via CDN those headers are not ours.
  Either the result page must be served cross-origin isolated, or the runtime needs an AtomVM
  build without the pthread path. Popcorn 0.4 requires the same headers, so this outlives 0.3.
- **Hosting**: the matched set belongs in `browser-compilers` (or an npm package) and referenced
  from `vendors.ts`, rather than vendored into the language directory.
- **Contract mapping**: stdout/stderr come from `onStdout`/`onStderr`; the inspected value is the
  result; `exitCode` is ours to define (`0` on success, `1` on abort/timeout), and the timeout is
  load-bearing rather than exceptional.
- **No stdin**, so the language is eval-shaped: no competitive-programming-style input.

## 9. Provenance notes

Diagnostics from the bundle leak its build machine:
`/Users/yamauchi/repos/popcorn/examples/eval_in_wasm/lib/eval_in_wasm.ex`. Combined with the
`Popcorn.Wasm` / `handle_wasm/2` API shape, that dates the bundle to a 0.3-era checkout of
Popcorn's own eval example — consistent with it being a redistribution of that example's output.
Provenance and the rebuild path are in [public/wasm/VERSION.md](public/wasm/VERSION.md).

## 10. Reproducing the verification

```bash
npm start                 # → http://localhost:8125/
npm run check             # syntax-check serve.js and public/main.js
npm run start:no-isolation  # then reload → boot fails; proves §6
```

Driven here with the `agent-browser` CLI against headless Chrome: select each example, click
Run, and read `document.documentElement.dataset.status` (`booting` / `ready` / `running` / `done`
/ `error` / `failed`) plus the `#result` and `#logs` panes. One Windows-specific gotcha, recorded
because it cost real time: PowerShell 5.1 strips embedded double quotes from native-command
arguments, so `eval` scripts must avoid string literals entirely — the page's element ids are
exposed as globals (`result`, `logs`, `editor`, `examples`), which is what the probes used.
