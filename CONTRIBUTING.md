# Contributing

Thanks for helping improve Agentic Tiles.

## Before opening a pull request

1. Keep changes focused and describe the user-visible result.
2. Add or update tests for behavioral changes.
3. Run the shared UI checks:

   ```bash
   npm ci
   npm test
   npm run build
   ```

4. Run the extension checks when changing VS Code integration:

   ```bash
   cd vscode-extension
   npm ci
   npm test
   npm run build
   ```

Please report security-sensitive issues privately rather than in a public issue. See
[SECURITY.md](SECURITY.md).
