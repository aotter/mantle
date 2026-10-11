/** Generated code imports `@aotter/mantle-next/<kernel module>`; tests run it from source. */
export const link = (code: string, from = "../src/kernel/") => code.replace(/"@aotter\/mantle-next\/([^"]+)"/g, (_, path) => JSON.stringify(`${from}${path}.ts`));
