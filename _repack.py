import zipfile, os
out = 'attaclone-dedup-1.0.0.xpi'
if os.path.exists(out): os.remove(out)
include = ['manifest.json','bootstrap.js','chrome.manifest','content','locale']
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
    for entry in include:
        if os.path.isfile(entry):
            z.write(entry, entry)
        elif os.path.isdir(entry):
            for root,_,files in os.walk(entry):
                for f in files:
                    p = os.path.join(root, f)
                    arc = p.replace(os.sep, '/')
                    z.write(p, arc)
print('Built', out)
