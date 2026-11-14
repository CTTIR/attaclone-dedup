async function runFixture(Zotero, IOUtils, root, checks) {
  const ok = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
  const item = async (title, doi) => {
    const value = new Zotero.Item('journalArticle');
    value.libraryID = Zotero.Libraries.userLibraryID;
    value.setField('title', title);
    if (doi) value.setField('DOI', doi);
    await value.saveTx();
    return value;
  };
  const stamp = Date.now();
    const D = Zotero.AttacloneDedup;
    const parent = await item('Synthetic duplicate attachment audit '+stamp);
    const pdf = width => {
      let value='%PDF-1.4\n'; const offsets=[0];
      const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 '+width+' 200] /Resources << >> >>'];
      objects.forEach((body,i)=>{offsets.push(value.length);value+=(i+1)+' 0 obj\n'+body+'\nendobj\n';});
      const xref=value.length;value+='xref\n0 4\n0000000000 65535 f \n';
      for(const offset of offsets.slice(1)) value+=String(offset).padStart(10,'0')+' 00000 n \n';
      return value+'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';
    };
    const attachments=[];
    for (let i=0;i<3;i++) {
      const file=root+'/synthetic-'+stamp+'-'+i+'.pdf';
      await IOUtils.writeUTF8(file,pdf(i===2?201:200));
      const a=await Zotero.Attachments.importFromFile({file,parentItemID:parent.id,contentType:'application/pdf'});attachments.push(a);
    }
    const groups=await D._findDuplicateGroups(parent);
    ok(groups.length===1 && groups[0].members.length===2, 'real SHA256 groups identical bytes and excludes equal-size different bytes');
    const keeper=attachments[0], duplicate=attachments[1];
    const selection={keepIDs:[keeper.id],deleteIDs:[duplicate.id]};
    const preview=await D._resolveGroup(parent,groups[0],selection);
    ok(preview.changed===0 && preview.planned===1 && !duplicate.deleted, 'default preview preserves actual database');
    const duplicatePath=await duplicate.getFilePathAsync();
    Zotero.Prefs.set(D.prefBranch+'dryRun',false,true);
    const applied=await D._resolveGroup(parent,groups[0],selection);
    ok(applied.changed===1 && duplicate.deleted && !keeper.deleted && !attachments[2].deleted, 'explicit apply trashes only verified duplicate');
    ok(await IOUtils.exists(duplicatePath), 'Trash preserves attachment bytes');
    duplicate.deleted=false;await duplicate.saveTx();
    ok(!duplicate.deleted && await IOUtils.exists(duplicatePath), 'actual restore retains attachment identity and file');
    Zotero.Prefs.set(D.prefBranch+'dryRun',true,true);
}
function isReady(Zotero) { return Boolean(Zotero.AttacloneDedup); }
function isStopped(Zotero) { return !Zotero.AttacloneDedup; }
function checkShutdown(Zotero, checks) { if (!isStopped(Zotero)) throw new Error("Addon namespace survived shutdown"); checks.push("actual addon shutdown removes namespace"); }
