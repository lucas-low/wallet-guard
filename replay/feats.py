import json,urllib.request,time,concurrent.futures as cf
sp=set()
for f in ("benign_sample.jsonl","mal_run.jsonl"):
    for l in open(f): sp.add(json.loads(l)["spender"])
def one(a):
    for i in range(4):
        try:
            r=urllib.request.urlopen(urllib.request.Request(f"https://sourcify.dev/server/v2/contract/1/{a}?fields=deployment",headers={"user-agent":"replay/0.1"}),timeout=30)
            d=json.load(r); return a,{"verified":True,"deployBlock":int(d["deployment"]["blockNumber"]) if d.get("deployment") and d["deployment"].get("blockNumber") else None}
        except urllib.error.HTTPError as e:
            if e.code==404: return a,{"verified":False}
        except Exception: pass
        time.sleep(2*(i+1))
    return a,None
with cf.ThreadPoolExecutor(4) as ex: res=dict(ex.map(one,sorted(sp)))
json.dump(res,open("feats.json","w")); 
from collections import Counter
print(len(res),Counter("fail" if v is None else "verified" if v["verified"] else "unverified" for v in res.values()), sum(1 for v in res.values() if v and v["verified"] and v["deployBlock"] is None))
