/** Required application seam `consent-page-brand` (packages/mantle/tests/application-seams.ts). Public imports only, no casts. */
import { authRoutes, type ConsentPageBrand } from "@aotter/mantle/auth/routes";

const brand: ConsentPageBrand = { name: "Seam", logo: "/logo.svg", primary: "#0f766e", primaryForeground: "#ffffff" };

export const routes = authRoutes(
  { cookiePrefix: "seam", get: () => Promise.reject(new Error("not loaded")) },
  { methods: [], brand },
);
