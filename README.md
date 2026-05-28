# @hasna/configs

AI coding agent configuration manager — store, version, apply, and share all your AI coding configs. CLI + MCP + REST API + Dashboard.

[![npm](https://img.shields.io/npm/v/@hasna/configs)](https://www.npmjs.com/package/@hasna/configs)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/configs
```

## CLI Usage

```bash
configs --help
configs profile resolve
configs profile apply --auto
```

## MCP Server

```bash
configs-mcp
```

## HTTP mode

```bash
configs-mcp --http               # http://127.0.0.1:8807/mcp
MCP_HTTP=1 configs-mcp
```

Health: `GET http://127.0.0.1:8807/health`. MCP is also mounted on `configs-serve` at `/mcp`.

## REST API

```bash
configs-serve
```

## Cloud Sync

This package supports cloud sync via `@hasna/cloud`:

```bash
cloud setup
cloud sync push --service configs
cloud sync pull --service configs
```

## Data Directory

Data is stored in `~/.hasna/configs/`.

## Machine-aware Profiles

`configs init` now seeds two platform profiles:

- `linux-arm64` for `spark01` / `spark02`
- `macos-arm64` for `apple01` / `apple03`

These profiles resolve machine variables like `{{WORKSPACE_ROOT}}`, `{{BUN_BIN_DIR}}`, `{{BUN_PATH}}`, and `{{PATH_PREFIX}}`, so synced configs can be portable across Linux and macOS arm64 machines.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
