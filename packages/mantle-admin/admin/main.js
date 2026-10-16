// The page `@aotter/mantle-admin/build` builds: the application's Admin entry (or the built-in one), mounted.
// Admin's styles first: the application's own CSS (imported by its entry) then overrides the default tokens
import "./styles.css";
import admin from "virtual:mantle-admin/entry";
import { mountAdmin } from "../admin-app/mount.js";

mountAdmin(admin);
