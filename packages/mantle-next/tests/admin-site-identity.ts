/** Native identity fixture shared by local hosts and the opt-in D1 Worker. */
import {betterAuth} from "better-auth/minimal";
import {admin,emailOTP} from "better-auth/plugins";
import {createAccessControl} from "better-auth/plugins/access";
import {defaultStatements} from "better-auth/plugins/admin/access";
import {d1Adapter,bunSqlAdapter} from "../src/auth/adapter.js";
import {d1Identity,postgresIdentity} from "../src/auth/identity.js";
import {authSchemaSql} from "../src/auth/schema.js";
export async function identityFixture(db:any,postgres:boolean,execute:(sql:string)=>Promise<unknown>) {
  const ac=createAccessControl(defaultStatements);let otp="";
  const options={baseURL:"https://app.test/api/auth",secret:"admin-site-test-secret-01234567890123456789",database:postgres?bunSqlAdapter(db):d1Adapter(db),user:{additionalFields:{githubLogin:{type:"string" as const,required:false}}},plugins:[admin({adminRoles:["staff"],ac,roles:{staff:ac.newRole(defaultStatements),user:ac.newRole({user:[],session:[]})}}),emailOTP({sendVerificationOTP:async({otp:code})=>{otp=code;}})]};
  for(const sql of authSchemaSql(options,postgres?"postgres":"sqlite"))await execute(sql);
  const auth=betterAuth(options),ctx=await auth.$context;
  for(const [id,role,verified] of [["staff","staff",true],["pending","user",false],["m1","user",true],["m2","user",true]] as const)await ctx.internalAdapter.createUser({id,email:id+"@example.test",name:id,role,emailVerified:verified,githubLogin:null},{method:"admin"});
  await auth.api.sendVerificationOTP({body:{email:"staff@example.test",type:"sign-in"}});
  const signed=await auth.api.signInEmailOTP({body:{email:"staff@example.test",otp},returnHeaders:true});
  const cookie=signed.headers.getSetCookie().map(v=>v.split(";")[0]).join("; ");
  return {cookie,directory:(c:any)=>postgres?postgresIdentity(db,auth,c.caller,c.request.headers):d1Identity(db,auth,c.caller,c.request.headers)};
}
