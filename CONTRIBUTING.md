# Contributing to Perlego Book Exporter Pro

Contributions, bug reports, and feature ideas are welcome!

## Principles

- **Zero Runtime Dependencies**: All extension runtime code under `src/` uses standard Web & Chrome Manifest V3 APIs with no external npm bundles or build step required.
- **Manifest V3 Strict Compliance**: Never introduce `eval()`, inline scripts/handlers in extension HTML, or persistent state inside global service-worker variables.
- **Accessible & Adaptive UI**: Follow modern web standards for semantic HTML, keyboard navigation, reduced motion, and `light-dark()` color schemes.

## Local Development Workflow

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/iamMortazavi/perlego-book-exporter.git
   cd perlego-book-exporter
   ```
2. Load the repository folder as an unpacked extension at `chrome://extensions`.
3. Make your changes under `src/` and add/update unit tests in `tests/extension.test.mjs`.
4. Run full verification before opening a pull request:
   ```bash
   npm run verify
   npm run pack
   ```

## Pull Request Checklist

- [ ] `npm run verify` passes with zero errors.
- [ ] New behaviors and bug fixes include unit tests in `tests/extension.test.mjs`.
- [ ] `manifest.json` and `package.json` versions stay synchronized on release PRs.
- [ ] No extraneous files (`.DS_Store`, `dist/`, temporary files) are committed.
