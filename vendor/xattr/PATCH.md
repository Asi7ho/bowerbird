# Why this crate is vendored and patched

Upstream `xattr` 0.2.3 (via `gpui` → `gpui_http_client` → `zed-async-tar`)
does not build against current `libc` on Linux:

```
error[E0425]: cannot find value `ENOATTR` in crate `::libc`
```

Newer `libc` removed `ENOATTR` for Linux, because glibc does not define it:
a missing extended attribute on Linux is reported as `ENODATA` (61).
The only change in this copy is in `src/sys/mod.rs`: on Linux,
`ENOATTR` is defined as 61 directly; every other platform keeps the
`libc::ENOATTR` constant exactly as upstream.

Nothing else in this copy is modified (see `Cargo.toml.orig` for the
upstream manifest). If upstream ever ships a fixed release, delete this
directory and the `[patch.crates-io]` entry in the workspace `Cargo.toml`.
