// Test stub for the `server-only` marker package.
//
// The real package throws at import time unless it is resolved under the
// `react-server` export condition, which a plain Vitest run never sets. Aliasing
// it here (see vitest.config.ts) lets server modules be imported in unit tests
// without the bundler, and without leaking `react-server` into other deps.
export {};
