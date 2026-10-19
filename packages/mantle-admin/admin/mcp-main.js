// The Admin MCP App `@aotter/mantle-admin/build` builds beside the page: the same application entry, mounted for an MCP host.
// Admin's styles first: the application's own CSS (imported by its entry) then overrides the default tokens.
import "./mcp-styles.css";
import admin from "virtual:mantle-admin/entry";
import { mountMcpApp } from "../admin-app/mcp-mount.js";

mountMcpApp(admin);
