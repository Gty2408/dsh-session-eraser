# Publishing

How this package reaches npm and the DSH plugin market.

## 1. Publish to npm

```sh
npm adduser                 # once per machine
npm publish                 # non-scoped package: public by default
```

Before the first publish, replace the placeholders in `package.json`:

- `author` — your name
- `repository.url`, `homepage`, `bugs.url` — your GitHub repo

Version bumps before every republish (npm refuses to overwrite a version):

```sh
npm version patch   # bug fix
npm version minor   # new feature
npm publish
```

## 2. Get listed in the DSH plugin market

The market does **not** read npm directly. It renders a curated catalog served at
`https://awesome-dsh-plugin.com/plugins.json`, which is generated from:

**https://github.com/awesome-dsh-plugin/awesome-dsh-plugin**

To be listed, open a PR there adding one entry. The catalog's CI backfills the
npm mapping, star count, download counts, and detected capabilities, and the
entry usually appears within a day.

Fields the catalog carries for a listed plugin (most are CI-generated — a PR
normally supplies the identity and description):

| Field | Source |
| --- | --- |
| `name`, `owner`, `url` | The PR entry |
| `category` | The PR entry (`session` fits this plugin) |
| `description.{en,zh}` | The PR entry |
| `npm`, `version` | CI, from the repo's `package.json` |
| `stars`, `downloads` | CI |
| `capabilities`, `capabilityRedLines` | CI, by inspection |
| `install` | CI, derived from the package name |

The resulting listing renders as `dsh plugin --profile web add <package>`, which
is the same command documented in the README.

## 3. Checklist

- [ ] `npm pack --dry-run` shows the intended files
- [ ] `node test/run.mjs` passes (the `live-*` suites need a running app)
- [ ] `package.json` has no `private: true`
- [ ] `name`, `cordis.patch.yml`, and `lib/client.js` all use the same identifier
- [ ] `npm publish` succeeded
- [ ] PR opened against `awesome-dsh-plugin/awesome-dsh-plugin`

## Identifier rules

Three places must carry the **same** package identifier or the browser half never
loads:

| File | Field |
| --- | --- |
| `package.json` | `name` |
| `cordis.patch.yml` | the inserted row's `name` (the module to load) |
| `lib/client.js` | `window.__ModuleLoader__.load({ id })` |

The patch row's `id` is only a label and may differ, but keeping it equal reads
better. `lib/index.js`'s `name` is the Cordis plugin identity used in logs and is
independent of the package name.

The HTTP route path (`/api/session.delete`) is a stable API path, not an
identifier, and is deliberately not tied to the package name.