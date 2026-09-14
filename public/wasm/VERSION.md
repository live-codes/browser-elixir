# The vendored runtime

These five files are **one matched set** and must be updated together. They are the
runtime side of [Popcorn](https://github.com/software-mansion/popcorn) 0.3 — AtomVM
compiled to WebAssembly — plus the `eval-in-wasm` application bundle, which carries
the Elixir compiler *inside* the VM so the page can `Code.eval_string/3` arbitrary
code.

| file | bytes | sha256 (as vendored) |
| --- | --- | --- |
| `popcorn.js` | 13,530 | `d809466021e901e2e8407a9dcc7a1010916497cd8101eafe2f5cb1f4f547d255` |
| `popcorn_iframe.js` | 5,534 | `4b5e38ec42c6aef209c93b8bf8ab536d45c40a87d771d007cc8c82e5674c8a27` |
| `AtomVM.mjs` | 149,754 | `07c3e14aeb0c3ad695195457e99fa1047730a505a874d4be8f8307676a9eedea` |
| `AtomVM.wasm` | 997,332 | `80a10d62b1153fec6cf8eb3991a138f533b1c5e4e51d9c17b62659e827087c7f` |
| `bundle.avm` | 7,114,092 | `6e25339e38f9d9ee3988b648802f56cf86004e0cec4af997f3ee41d94043f1af` |

## Why they must stay together

The JavaScript bridge and the `.avm` bundle speak a private protocol and are
**version-locked**. This set uses the handshake where the parent sends
`popcorn-init` / `popcorn-startVm` and Elixir calls `Popcorn.Wasm.register/1`, which
lands in the iframe as `Module.onElixirReady`.

Every published `@swmansion/popcorn` (0.2.x and 0.3.x alike) instead ships a
refactored runtime — `dist/iframe.mjs` + `dist/popcorn.mjs`, a 4.1–4.2 MB *debug*
`AtomVM.wasm`, and a `Popcorn.Wasm.ready/0,1` + `set_default_receiver/1` handshake
over a `popcorn-event` channel. Pairing that runtime with this bundle makes
`Popcorn.init()` wait forever for a `ready/0` this bundle never calls.

So: do **not** swap `popcorn.js` / `popcorn_iframe.js` for a version from npm, and do
**not** drop in a `.avm` cooked against a different popcorn. Either replace all five
files, or rebuild the bundle to match the runtime you pin.

## Provenance

Vendored unmodified from the `static/` deployment of
[TORIFUKUKaiou/elixir-browser-eval](https://github.com/TORIFUKUKaiou/elixir-browser-eval),
which is Popcorn's own `examples/eval-in-wasm` built with `mix popcorn.cook` and
deployed as static files. The Elixir/OTP versions that build pins are OTP 26.0.2 and
Elixir 1.17.3.

This repo redistributes those artifacts; it does not produce them. That is the
weakest link here and the first thing to fix — see `FINDINGS.md`. Popcorn is
Apache-2.0, AtomVM is Apache-2.0 (see `LICENSE`).

## Rebuilding the bundle

To own the whole stack, clone Popcorn at the tag matching `@swmansion/popcorn@0.3.3`,
install the pinned toolchain with `mise install`, then:

```bash
cd examples/eval-in-wasm
mix deps.get
mix popcorn.cook
```

The plugin's output lands in `static/wasm/` (or `dist/wasm/`), and its `popcorn.js`,
`popcorn_iframe.js` and `AtomVM.*` belong to that same build — take all of them. The
runtime would then be pinnable to jsDelivr rather than vendored.
