const fs=require('fs');const d=require('docx');const F='Calibri';
const H=t=>new d.Paragraph({spacing:{before:240,after:100},children:[new d.TextRun({text:t,font:F,size:28,bold:true})]});
const P=t=>new d.Paragraph({spacing:{after:100},children:[new d.TextRun({text:t,font:F,size:22})]});
const B=t=>new d.Paragraph({spacing:{after:60},bullet:{level:0},children:[new d.TextRun({text:t,font:F,size:22})]});
const doc=new d.Document({sections:[{children:[
new d.Paragraph({spacing:{after:160},children:[new d.TextRun({text:'Future Generation Computer Systems: submission checklist',font:F,size:36,bold:true})]}),
P('Prepared 14 Nov 2026. Items in [brackets] are for you to fill in or confirm before you press submit.'),
H('1. Files to upload'),
B('FGCS_manuscript.docx (main manuscript, single column, line numbers, figures and tables embedded). Elsevier accepts Word at first submission.'),
B('FGCS_manuscript_highlights.docx (Highlights file, five bullets, each 85 characters or fewer).'),
B('FGCS_cover_letter.docx (fill in the date and the suggested reviewers).'),
B('Figures: Elsevier may ask for the figures as separate files. They are in the repository under the figures folders.'),
B('Optional: a graphical abstract. Encouraged by Elsevier, not required.'),
H('2. Text for the submission form'),
P('Title: Blockchain-Assisted Zero-Trust Access Control and Verifiable Audit for Industrial IoT'),
P('Authors, in order: Syed Irfan Raza Naqvi (corresponding), Muhammad Umar Aftab, Ahmad Mohsin, Rana Asif Rehman, Sayed Qaiser Ali Shah. Postal addresses were supplied by you for all five authors. [Each author should still confirm name spelling, department and e-mail.]'),
P('Keywords: Zero trust; Access control; Industrial IoT; Blockchain; Audit integrity; Revocation; Smart contracts'),
P('Abstract and Highlights: copy them from the manuscript and the highlights file so the form matches the paper exactly.'),
H('3. Declarations (the manuscript already contains them)'),
B('Competing interests: none declared. [Confirm with your supervisor.]'),
B('Funding: the manuscript states that the research received no specific grant. Say the same in the submission form.'),
B('Data and code availability: https://github.com/irfanrazanaqvi/bc-zta-iiot-experiments. [Add the Zenodo DOI once you publish a release.]'),
B('Generative AI: the manuscript states that Claude was used for experiment code, data analysis and language editing, and that the authors reviewed everything. Keep it, and only keep it if it is true.'),
B('CRediT: Mohsin, Rehman and Shah are listed with Supervision only. Add any other roles they actually had (for example Writing – review and editing) before submitting.'),
H('4. Choices in the system'),
B('Publishing route: choose the subscription (not open access) option, so there is no article charge. Open access is the paid option.'),
B('Preprint: Elsevier allows one. A preprint is optional and you can skip it.'),
B('Suggested reviewers: three to five people who work on zero trust or IIoT security, are not co-authors or colleagues, and whose institutional e-mails you can verify. Do not guess addresses.'),
H('5. Check before submitting'),
B('Read the official Guide for Authors on the journal page once. I could not open it from here, so the scope notes and the highlights rule come from the journal page summary and from Elsevier\'s general rules.'),
B('References: the manuscript uses numbered references. Elsevier lets you use any consistent style at first submission. Reformat only if the editor asks.'),
B('Ask your supervisor to read the PDF once and approve the author list and the declarations.'),
B('Your own wording: read the abstract and the cover letter aloud once. Change any sentence that does not sound like you.'),
H('6. What to expect'),
B('A desk decision can come within a few weeks. Full review often takes several months. The journal page on ScienceDirect shows its current review times.'),
B('Reviewers at this journal often ask for evaluation at larger scale or with real devices. The paper uses up to 200 emulated devices in one cloud zone and says so. Be ready to answer that in the same way, and to describe it as future work.'),
]}]});
d.Packer.toBuffer(doc).then(b=>fs.writeFileSync('/tmp/claude-0/work/fgcs/FGCS_submission_checklist.docx',b));
