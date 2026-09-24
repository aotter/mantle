import type { AdminAuth, AdminStaffUser, StaffRole } from '@aotter/mantle/admin';

export interface Env { DB: D1Database; ASSETS?: Fetcher; PUBLIC_ORIGIN: string; OWNER_EMAIL?: string }
type UserRow = { id: string; email: string; name: string; role: StaffRole | null; created_at: string; signed_in: number };
const project = (row: UserRow): AdminStaffUser => ({ id:row.id,email:row.email,name:row.name,role:row.role,githubLogin:null,emailVerified:!!row.signed_in,createdAt:new Date(row.created_at) });

// This adapter must only receive requests through Sites' identity-stripping dispatcher.
// Never expose the Worker independently with caller-controlled oai-* headers.
export function readIdentity(request: Request) {
  const sub=request.headers.get('oai-authenticated-user-id');
  const email=request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  if(!sub || !email || sub.length>512 || email.length>320) return null;
  let name=email;
  if(request.headers.get('oai-authenticated-user-full-name-encoding')==='percent-encoded-utf-8') {
    try { name=decodeURIComponent(request.headers.get('oai-authenticated-user-full-name')||'')||email; } catch {}
  }
  return {id:`chatgpt:${sub}`,email,name};
}

export function createChatGPTAuth(env: Env): AdminAuth {
  const db=env.DB;
  const roleFor=async(id:string)=>(await db.prepare('SELECT role FROM sites_users WHERE id = ?').bind(id).first<{role:StaffRole|null}>())?.role??null;
  const auth: AdminAuth = {
    basePath:'/api/auth', methods:[],
    async getSession(request) {
      const who=readIdentity(request); if(!who)return null;
      let row=await db.prepare('SELECT * FROM sites_users WHERE id=?').bind(who.id).first<UserRow>();
      if(!row){
        // Claim an invitation before inserting; a stable identity keeps its existing role if its email later changes.
        await db.prepare('UPDATE sites_users SET id=?,name=?,signed_in=1 WHERE email=? AND signed_in=0').bind(who.id,who.name,who.email).run();
        await db.prepare('INSERT OR IGNORE INTO sites_users (id,email,name,role,signed_in) VALUES (?,?,?,?,1)')
          .bind(who.id,who.email,who.name,who.email===env.OWNER_EMAIL?.trim().toLowerCase()?'owner':null).run();
        row=await db.prepare('SELECT * FROM sites_users WHERE id=?').bind(who.id).first<UserRow>();
      }
      if(!row)return null;
      return {session:{id:`sites:${who.id}`},user:{id:row.id,email:row.email,name:row.name,role:row.role,roleCurrent:true}};
    },
    getUserRole:roleFor,
    async handler(request) {
      const path=new URL(request.url).pathname;
      if(path==='/api/auth/get-session' && request.method==='GET') return Response.json(await auth.getSession(request));
      if(path==='/api/auth/sign-out' && request.method==='POST') {
        if(request.headers.get('origin')!==env.PUBLIC_ORIGIN)return new Response('Forbidden',{status:403});
        // The shipped Admin UI navigates here after its POST; the next top-level request signs out at Sites.
        return Response.json({success:true},{headers:{'set-cookie':'mantle-sites-signout=1; Path=/admin/sign-in; HttpOnly; SameSite=Strict; Max-Age=60'+(env.PUBLIC_ORIGIN.startsWith('https:')?'; Secure':'')}});
      }
      return Response.json({error:'unsupported_auth_route'},{status:404});
    },
    async listUsers(){const r=await db.prepare('SELECT * FROM sites_users WHERE role IS NOT NULL ORDER BY created_at,id').all<UserRow>();return r.results.map(project);},
    async listMembers(args){
      // ponytail: one bounded page for this integration lab; add cursor pagination before a large member rollout.
      const r=await db.prepare('SELECT * FROM sites_users WHERE role IS NULL AND (email LIKE ? OR name LIKE ?) ORDER BY created_at,id LIMIT ?').bind(`%${args.search||''}%`,`%${args.search||''}%`,Math.min(args.limit,100)).all<UserRow>();
      return {items:r.results.map(project),previousCursor:null,nextCursor:null};
    },
    async setUserRole(id,role){if(role!==null&&!['owner','editor','contributor'].includes(role))throw new Error('Invalid role');return !!(await db.prepare('UPDATE sites_users SET role=? WHERE id=?').bind(role,id).run()).meta.changes;},
    async inviteUser(email,role){
      const normalized=email.trim().toLowerCase();const id=`invite:${crypto.randomUUID()}`;
      const r=await db.prepare('INSERT OR IGNORE INTO sites_users (id,email,name,role,signed_in) VALUES (?,?,?,?,0)').bind(id,normalized,normalized,role).run();
      if(r.meta.changes)return {kind:'created',id};
      const existing=await db.prepare('SELECT id FROM sites_users WHERE email=?').bind(normalized).first<{id:string}>();
      if(!existing)throw new Error('Invitation could not be saved');return {kind:'exists',id:existing.id};
    },
    async revokeInvite(id){return !!(await db.prepare('DELETE FROM sites_users WHERE id=? AND signed_in=0').bind(id).run()).meta.changes;},
  };
  return auth;
}
