# ADR-lite: object key and count rules for generated inputs

**Status:** Accepted direction for issue #1972. Extends the generated input validation of [ADR-0044](0044-generate-time-lowering.md).

View and Procedure inputs may constrain the number and names of their own object
properties. Generate checks `minProperties` and `maxProperties` as non-negative
safe integers. It compiles `propertyNames` with `pattern`, `not.enum` of strings,
or both, and an optional `maxLength`. Key patterns use the same static regex
work budget and length checks as string values. Rejections report the object's
path for a count and the exact key's escaped path for a name.

REST, MCP and Admin reuse the generated validator. HTTP View query parameters
still use the declared-field projection. Paging values also remain separate
from authored inputs. Describe retains authored rules, and MCP and WebMCP
advertise them as sentences so synthetic paging fields are outside the rules.
