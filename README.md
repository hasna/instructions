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
```

## MCP Server

```bash
configs-mcp
```

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

## License

Apache-2.0 -- see [LICENSE](LICENSE)
