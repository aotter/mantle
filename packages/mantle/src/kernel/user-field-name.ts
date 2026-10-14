const name = /^[a-z][a-zA-Z0-9_]{0,62}$/;
const reserved = " id email emailVerified name image createdAt updatedAt role banned banReason banExpires ";
export const validUserFieldName = (field: string): boolean => name.test(field) && !reserved.includes(' '+field+' ') && !field.startsWith("mantle");
