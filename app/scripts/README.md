# Repository tooling

Runtime code does not live here. CLI files only parse options, read/write
artifacts, and call reusable code from the nearest `lib/` directory.

- `build/` assembles or previews deployable artifacts and precomputes routes.
- `railway/` owns railway-package ingestion, normalization, topology repair,
  validation primitives, and the raw inputs under `railway/data/`.
- `samples/` generates committed example train stores.
- `validation/` contains repository and railway audit entry points.
- `migrations/` preserves already-run, one-shot data corrections.
- `lib/` contains the browser-script sandbox and sample-generation helpers
  shared by build scripts and tests; railway-only helpers stay in
  `railway/lib/`.

The dependency direction is:

```text
build / samples / validation / migrations
                  ↓
        lib / railway/lib
                  ↓
              shared/
```

Tooling may read runtime modules for parity checks, but runtime modules must
never import from `scripts/`.
