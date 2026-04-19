# Contributing to Mindstone MCP Servers

Thanks for your interest in contributing! This document explains how to get involved.

## Getting Started

1. Fork the repository
2. Clone your fork and create a feature branch:
   ```bash
   git clone https://github.com/<your-username>/mcp-servers.git
   cd mcp-servers
   git checkout -b my-feature
   ```
3. Each connector is self-contained under `connectors/<name>/`. Install and build independently:
   ```bash
   cd connectors/<name>
   npm install
   npm run build
   ```

## Repository Structure

```
connectors/
  _template/       # Starter template for new connectors
  zendesk/         # Each connector is an independent package
  freshdesk/
  ...
test-harness/      # Shared test utilities (linked via file: dependency)
```

## Adding a New Connector

1. Copy `connectors/_template/` to `connectors/<your-connector>/`
2. Update `package.json` with the connector name and description
3. Update the `LICENSE` file — replace the placeholder software name
4. Implement the connector following the patterns in existing connectors
5. Add tests using the shared test harness
6. Add a `README.md` with setup and configuration instructions
7. Submit a pull request

## Development Guidelines

- **TypeScript**: All connectors are written in TypeScript with strict mode
- **Testing**: Use Vitest. Every connector should have smoke tests, tool tests, and error handling tests
- **Linting**: Run `npm run lint` before submitting
- **Dependencies**: Keep dependencies minimal. Use the MCP SDK (`@modelcontextprotocol/sdk`) and Zod for validation

## Pull Requests

- Keep PRs focused on a single change
- Include tests for new functionality
- Update the connector's README if behaviour changes
- Ensure all existing tests pass: `npm test`
- Use clear commit messages describing what changed and why

## Reporting Issues

- **Security vulnerabilities**: See [SECURITY.md](SECURITY.md) — do not open public issues
- **Bugs**: Open a GitHub issue with reproduction steps
- **Feature requests**: Open a GitHub issue describing the use case

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## Licence

By contributing, you agree that your contributions will be licensed under the same [FSL-1.1-MIT](LICENSE) licence as the rest of the project.
