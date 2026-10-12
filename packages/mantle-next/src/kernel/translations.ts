/** Locale values stay ordinary strings; applications opt into canonicalisation. */
import { ContractError } from "./contracts.js";
export function toCanonicalLocale(value: string): string {
  if (typeof value !== "string" || !value) throw new ContractError("INPUT_VALIDATION_FAILED", "Invalid locale.", "locale");
  let parts = value.replaceAll("_", "-").split("-");
  if (parts.length === 1 && parts[0]!.length === 4) parts = [parts[0]!.slice(0,2),parts[0]!.slice(2)];
  const language = parts[0]!, region = parts[1];
  if (!/^[A-Za-z]{2,3}$/.test(language) || region !== undefined && !/^[A-Za-z]{2}$/.test(region)) throw new ContractError("INPUT_VALIDATION_FAILED", "Invalid locale.", "locale");
  return language.toLowerCase() + (region === undefined ? "" : "-" + region.toUpperCase());
}
