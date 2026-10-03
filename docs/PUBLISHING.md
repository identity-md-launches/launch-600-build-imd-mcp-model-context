# Publishing

The package is not yet published on npm or listed in the official MCP Registry.
The repository owner runs these steps from the repository root, in order,
with npm publishing credentials and `mcp-publisher` installed:

1. Add `"mcpName": "io.github.identity-md-launches/imd-mcp"` to the top-level
   object in `package.json`. Keep the package name `imd-mcp` and the version
   aligned with `server.json` (currently `0.1.0`).
2. Publish the package as `imd-mcp`:

   ```sh
   npm publish
   ```

3. Authenticate the publisher with GitHub:

   ```sh
   mcp-publisher login github
   ```

4. Publish the root `server.json` to the official MCP Registry
   (`registry.modelcontextprotocol.io`):

   ```sh
   mcp-publisher publish
   ```

The `mcpName` field addition and the npm publish cannot be done by a swarm
job because `package.json` is a protected path. These are owner actions;
this round only prepares the metadata and instructions.

The Glama listing is claimed by a maintainer named in `glama.json`, currently
`surfer77`. Adding that file does not itself claim or publish a listing.
