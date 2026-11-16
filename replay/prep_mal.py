import json,time,urllib.request,random,sys
from collections import Counter
URL=sys.argv[1] if len(sys.argv)>1 else "https://rpc.mevblocker.io"; N=int(sys.argv[2]) if len(sys.argv)>2 else 3000
def rpc(method,params,tries=6):
    for i in range(tries):
        try:
            req=urllib.request.Request(URL,data=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(),headers={"content-type":"application/json","user-agent":"replay/0.1"})
            r=json.load(urllib.request.urlopen(req,timeout=60))
            if r.get("result") is not None: return r["result"]
            err=r.get("error")
        except Exception as e: err=str(e)
        time.sleep(1.5*(i+1))
    raise RuntimeError(f"{method}: {err}")
AP="0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"
logs=json.load(open("mal_logs.json")); labels=json.load(open("labels.json"))
# grants only: ERC-20 Approval with a non-zero amount, or ApprovalForAll set to true
logs=[l for l in logs if len(l["topics"])==3 and int(l["data"] or "0x0",16)>0]
print("grant logs",len(logs)); random.seed(20261116)
seen=set(); out=[]; shape=Counter()
for l in random.sample(logs,min(N,len(logs))):
    h=l["transactionHash"]
    if h in seen: continue
    seen.add(h)
    try: t=rpc("eth_getTransactionByHash",[h])
    except RuntimeError as e: shape["fetch_failed"]+=1; continue
    owner="0x"+l["topics"][1][26:]; sp="0x"+l["topics"][2][26:]; i=t["input"]; sel=i[:10]; b=int(l["blockNumber"],16)
    base={"label":"scam","sources":labels[sp],"block":b,"hash":h,"spender":sp,"from":owner}
    direct=t.get("to") and t["to"].lower()==l["address"].lower() and t["from"].lower()==owner
    if direct and sel in("0x095ea7b3","0x39509351","0xa22cb465") and "0x"+i[34:74]==sp:
        shape["direct_"+sel]+=1
        out.append({**base,"kind":"signed_tx","to":t["to"],"data":i,"value":str(int(t["value"],16))})
    elif l["topics"][0]==AP and t["from"].lower()!=owner and sel in("0xd505accf","0x8fcbaf0c"):
        # Someone else submitted it, so the owner signed an off-chain permit. Rebuild that message from the event.
        shape["permit_"+sel]+=1
        out.append({**base,"kind":"permit","req":{"kind":"typedData","primaryType":"Permit","verifyingContract":l["address"],"message":{"owner":owner,"spender":sp,"value":str(int(l["data"],16))}}})
    else: shape["other_"+sel]+=1
    if len(seen)%200==0: print(len(seen),dict(shape),flush=True)
print(dict(shape))
with open("mal_sample.jsonl","w") as f:
    for x in out: f.write(json.dumps(x)+"\n")
