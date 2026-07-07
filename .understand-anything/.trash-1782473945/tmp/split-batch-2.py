import json, math, os

base = '/Users/aotter/projects/aotter-clam-mantle-workroot/mantle/.understand-anything/intermediate/batch-2.json'
with open(base) as f:
    g = json.load(f)
nodes, edges = g['nodes'], g['edges']

nc, ec = len(nodes), len(edges)
parts = math.ceil(max(nc/60, ec/120))  # =2

# files in batch, alphabetical
with open('/Users/aotter/projects/aotter-clam-mantle-workroot/mantle/.understand-anything/tmp/batch-input-2.json') as f:
    bid = json.load(f)
files = sorted([x['path'] for x in bid['files']])
chunk = math.ceil(len(files)/parts)
groups = [set(files[i:i+chunk]) for i in range(0, len(files), chunk)]

# map node -> filePath
def node_fp(n):
    return n.get('filePath')

# assign nodes to part by filePath
node_part = {}
for n in nodes:
    fp = node_fp(n)
    pi = 0
    for i,grp in enumerate(groups):
        if fp in grp:
            pi = i; break
    node_part[n['id']] = pi

for k in range(len(groups)):
    pnodes = [n for n in nodes if node_part[n['id']]==k]
    pnode_ids = {n['id'] for n in pnodes}
    # edges whose source is a node in this part
    pedges = [e for e in edges if e['source'] in pnode_ids]
    outp = f'/Users/aotter/projects/aotter-clam-mantle-workroot/mantle/.understand-anything/intermediate/batch-2-part-{k+1}.json'
    with open(outp,'w') as f:
        json.dump({"nodes":pnodes,"edges":pedges}, f, ensure_ascii=False, indent=2)
    imp = sum(1 for e in pedges if e['type']=='imports')
    print(f'part {k+1}: nodes={len(pnodes)} edges={len(pedges)} imports={imp}')

# remove single-file version
os.remove(base)
tot_imp = sum(1 for e in edges if e['type']=='imports')
print('total imports across parts must be', tot_imp)
