import { defineAdmin } from "@aotter/mantle-admin/app";
import { admin } from "../generated/admin-client.js";

/**
 * The Admin entry, built by `mantle bundle`. The approver's daily work gets its own sidebar group above Admin's
 * built-in ones (content 10, operations 20, reports 30; More stays last); manifests place `pending-requests` and
 * `requests` in it with `uiSchema.nav`. `tsc` refuses a manifest group left undeclared here.
 * AGENT: add groups for how the staff work; titles take one string or a { locale: text } map.
 */
export default defineAdmin(admin, {
  nav: { groups: { approvals: { title: { en: "Approvals", "zh-TW": "簽核" }, order: 5 } } },
});
