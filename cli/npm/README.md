# @nagi-ovo/shiori

Thin installer for the Shiori CLI binary. This package is not the
CLI source. It downloads the same archive as

```text
curl -fsSL https://shiori.nagi.fun/cli | sh
```

and execs it. This package is only the fetcher; the CLI source is `cli/` in
the main repository.

```text
npm install -g @nagi-ovo/shiori
```
