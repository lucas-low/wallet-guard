import json,time,urllib.request,random
URL="https://eth.drpc.org"
def rpc(method,params,tries=6):
    for i in range(tries):
        try:
            req=urllib.request.Request(URL,data=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(),headers={"content-type":"application/json","user-agent":"replay/0.1"})
            r=json.load(urllib.request.urlopen(req,timeout=60))
            if "result" in r and r["result"] is not None: return r["result"]
            err=r.get("error")
        except Exception as e: err=str(e)
        time.sleep(1.5*(i+1))
    raise RuntimeError(f"{method}: {err}")
labels=json.load(open("labels.json"))
head=int(rpc("eth_blockNumber",[]),16)
random.seed(20261116)
blocks=sorted(random.sample(range(head-2_600_000,head-100),600))
AP="0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"
AFA="0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31"
out=[]
for n,b in enumerate(blocks):
    try:
        blk=rpc("eth_getBlockByNumber",[hex(b),True])
        ok={l["transactionHash"] for l in rpc("eth_getLogs",[{"fromBlock":hex(b),"toBlock":hex(b),"topics":[[AP,AFA]]}])}
    except RuntimeError as e: print("skip",b,e); continue
    for t in blk["transactions"]:
        i=t["input"]; sel=i[:10]
        if t["hash"] not in ok or not t.get("to") or len(i)<138: continue
        if sel=="0x095ea7b3" and int(i[74:138],16)>0: kind="approve"
        elif sel=="0xa22cb465" and int(i[74:138],16)==1: kind="setApprovalForAll"
        else: continue
        sp="0x"+i[34:74]
        if sp in labels: continue
        out.append({"kind":kind,"block":b,"hash":t["hash"],"from":t["from"],"to":t["to"],"data":i,"value":str(int(t["value"],16)),"spender":sp})
    if n%50==0: print(n,len(out),flush=True); json.dump(out,open("benign.json","w"))
json.dump(out,open("benign.json","w")); print("done",len(out))
