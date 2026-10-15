// The page `@aotter/mantle-admin/build` builds: the application's Admin entry (or the built-in one), mounted.
import admin from "virtual:mantle-admin/entry";
import { mountAdmin } from "../admin-app/mount.js";
import "./styles.css";

mountAdmin(admin);
