import {expect,test} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {PreferencesProvider} from "../src/app/preferences";
import {StatusBadge} from "../src/ui/status-badge";
test("operational NULL status has no badge and inherited names remain literal text",()=>{
  const html=(status:string|null)=>renderToStaticMarkup(<PreferencesProvider initialLanguage="en"><StatusBadge status={status}/></PreferencesProvider>);
  expect(html(null)).toBe("");
  for(const value of ["constructor","toString","__proto__"]){expect(html(value)).toContain(value);}
  expect(html("draft")).toContain("Draft");
});
