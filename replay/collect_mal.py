import json,time,urllib.request,csv,sys
URL="https://rpc.mevblocker.io"
def rpc(method,params,tries=6):
    for i in range(tries):
        try:
            req=urllib.request.Request(URL,data=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(),headers={"content-type":"application/json","user-agent":"replay/0.1"})
            r=json.load(urllib.request.urlopen(req,timeout=120))
            if "result" in r: return r["result"]
            err=r.get("error")
        except Exception as e: err=str(e)
        time.sleep(1.5*(i+1))
    raise RuntimeError(f"{method}: {err}")
labels={}
for a in json.load(open("labels/scamsniffer.dat")): labels.setdefault(a.lower(),[]).append("scamsniffer")
for r in csv.DictReader(open("labels/forta.dat")): labels.setdefault(r["address"].lower(),[]).append("etherscan:"+r["etherscan_tag"])
for r in json.load(open("labels/mew.dat")): labels.setdefault(r["address"].lower(),[]).append("mew-darklist")
json.dump(labels,open("labels.json","w"))
addrs=sorted(labels)
head=int(rpc("eth_blockNumber",[]),16)
AP="0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925"
AFA="0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31"
pad=lambda a:"0x"+"0"*24+a[2:]
def logs(lo,hi,topic,chunk):
    try: return rpc("eth_getLogs",[{"fromBlock":hex(lo),"toBlock":hex(hi),"topics":[topic,None,[pad(a) for a in chunk]]}],tries=3)
    except RuntimeError:
        if hi-lo<2000 and len(chunk)<=50: raise
        if hi-lo>=2000:
            mid=(lo+hi)//2; return logs(lo,mid,topic,chunk)+logs(mid+1,hi,topic,chunk)
        h=len(chunk)//2; return logs(lo,hi,topic,chunk[:h])+logs(lo,hi,topic,chunk[h:])
out=[]
START=10_000_000; STEP=500_000; CH=1000
for lo in range(START,head+1,STEP):
    hi=min(lo+STEP-1,head)
    for i in range(0,len(addrs),CH):
        for topic in (AP,AFA):
            out+=logs(lo,hi,topic,addrs[i:i+CH])
    print(lo,len(out),flush=True)
    json.dump(out,open("mal_logs.json","w"))
