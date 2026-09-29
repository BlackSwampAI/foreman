import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const docsDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(docsDir, '../..');
const playwrightModule = process.env.PLAYWRIGHT_MODULE ?? path.join(repoDir, 'node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightModule).href);

const now = '2026-09-29T14:00:00.000Z';
const events = [
  ['e1','project.planner_message_added','project','proj-atlas',{activity:{summary:'Planner outlined a safe approach for the API retry flow.'}}],
  ['e2','run.created','run','run-active',{activity:{summary:'Started Worker implementation for bounded retries.'}}],
  ['e3','controller.started','run','run-active',{activity:{summary:'Orchestrator is coordinating validation and review.'}}],
  ['e4','worker.completed','run','run-active',{activity:{summary:'Worker updated retry handling and added coverage.'}}],
  ['e5','run.validation_failed','run','run-failed',{activity:{summary:'Typecheck passed; API contract check failed on a missing timeout guard.'}}],
  ['e6','run.awaiting_approval','run','run-approval',{activity:{summary:'Reviewer recommends the verified result. Human approval is required.'}}],
].map(([id,type,entityType,entityId,extra],i)=>({id,type,entityType,entityId,at:`2026-09-29T13:${String(54+i).padStart(2,'0')}:00.000Z`,...extra}));
const baseRun = (id,status,phase)=>({id,status,createdAt:now,updatedAt:now,pinnedBaseCommit:'3b8f4c210a7751519cb06413aa4a5190bc4c4f2e',workspaceId:`workspace-${id}`,controller:{startedAt:now,phase,active:phase!=='stopped'&&phase!=='awaiting_approval',budgets:{roleTurns:{planner:3,orchestrator:3,worker:2,reviewer:2},workerAttempts:2}},assignments:[{id:id==='run-active'?'orchestrator-active':`orchestrator-${id}`,roleId:'orchestrator',status:'succeeded',createdAt:now,requestedConfig:{harnessId:'codex-cli',model:'gpt-5'},result:'Plan is ready; run focused typecheck and retry contract checks.'},{id:id==='run-active'?'worker-active':`worker-${id}`,roleId:'worker',status:'succeeded',createdAt:now,requestedConfig:{harnessId:'claude-code',model:'claude-sonnet-4'}}],guidance:[{id:`guidance-${id}`,text:'Keep retries bounded and preserve the original error context.',status:'applied',createdAt:now}],usage:{inputTokens:18240,outputTokens:2710,thinkingTokens:5200,cachedInputTokens:8064,runtimeMs:98400,requestCount:7,measured:true}});
const evidence=(id)=>({provenance:'recorded_replay',workerAssignmentId:`worker-${id}`,workspaceId:`workspace-${id}`,responseId:`response-${id}`,requestedModel:'claude-sonnet-4',actualModel:'claude-sonnet-4',actualModelStatus:'observed',pinnedBaseCommit:'3b8f4c210a7751519cb06413aa4a5190bc4c4f2e',completeSnapshot:{reportedComplete:true,reportedErrors:0,entryCount:38},scopeVerified:true,allowedScope:['src/retry.ts','tests/retry.test.ts'],changes:[{path:'src/retry.ts',kind:'modified',summary:'Bound retry attempts and keep the upstream error for diagnostics.'},{path:'tests/retry.test.ts',kind:'added',summary:'Cover backoff, timeout, and exhausted retries.'}],reviewDiff:'diff --git a/src/retry.ts b/src/retry.ts\n+const maxAttempts = Math.min(config.maxAttempts, 4);\n+if (signal.aborted) throw signal.reason;'});
const validation=(passed)=>({id:passed?'validation-ok':'validation-failed',status:passed?'passed':'failed',passed,checks:[{name:'TypeScript',passed:true,details:'No type errors.'},{name:'API contract',passed,details:passed?'Retry budget and timeout behavior match the contract.':'Expected timeout guard when the request is aborted.'},{name:'Unit tests',passed,details:passed?'42 tests passed.':'41 passed, 1 failed.'}],observations:[{name:'TypeScript',command:'pnpm',args:['typecheck'],exitCode:0,timedOut:false,output:'Typecheck completed with no errors.',passed:true},{name:'API contract',command:'pnpm',args:['test','--','retry'],exitCode:passed?0:1,timedOut:false,output:passed?'42 tests passed.':'Expected request abort to stop retry scheduling.\n\n1 test failed; 41 passed.',passed}],resultGate:{passed,reason:passed?'All configured checks passed.':'API contract check failed.'},policy:{requireAllChecksPass:true,configuredCheckCount:3},createdAt:now});
const tasks=[
{id:'task-idle',title:'Document retry behavior',goal:'Clarify retries, timeout handling, and operational limits.',suggestedAllowedPaths:['docs/api/retries.md'],validationCriteria:['Document the maximum attempt count','Explain timeout and cancellation behavior'],status:'ready',runs:[]},
{id:'task-active',title:'Bound API retries safely',goal:'Limit retries and preserve request cancellation behavior.',suggestedAllowedPaths:['src/retry.ts','tests/retry.test.ts'],validationCriteria:['Retry count is bounded','Abort signals stop retries','Existing error context is retained'],status:'in progress',runs:[{...baseRun('run-active','in_progress','validating'),validationProgress:{attemptId:'validation-active',startedAt:'2026-09-29T13:58:00.000Z',checks:[{name:'TypeScript',command:'pnpm',args:['typecheck'],status:'passed',output:'Typecheck completed with no errors.',outputTruncated:false,startedAt:'2026-09-29T13:58:00.000Z',finishedAt:'2026-09-29T13:58:49.000Z',elapsedMs:49000,exitCode:0},{name:'API contract',command:'pnpm',args:['test','--','retry'],status:'running',output:'Running focused timeout and cancellation cases…',outputTruncated:false,startedAt:'2026-09-29T13:58:00.000Z',elapsedMs:51000},{name:'Unit tests',command:'pnpm',args:['test'],status:'queued',output:'',outputTruncated:false}]},workerProposal:{id:'proposal-active',status:'dispatched',text:'Add a bounded retry policy with abort-aware backoff and focused tests.',orchestratorAssignmentId:'orchestrator-active',workerAssignmentId:'worker-active',createdAt:now},workerEvidence:evidence('active') }]},
{id:'task-failed',title:'Add request timeout guard',goal:'Stop retry scheduling when a request times out or is cancelled.',suggestedAllowedPaths:['src/retry.ts','tests/retry.test.ts'],validationCriteria:['Timeout cancels pending retries','Failure is reported clearly'],status:'failed',runs:[{...baseRun('run-failed','failed','stopped'),workerEvidence:evidence('failed'),validation:validation(false)}]},
{id:'task-approval',title:'Preserve upstream error details',goal:'Keep useful upstream diagnostics through retry exhaustion.',suggestedAllowedPaths:['src/retry.ts','tests/retry.test.ts'],validationCriteria:['Error metadata survives retries','Successful response behavior is unchanged'],status:'awaiting approval',runs:[{...baseRun('run-approval','awaiting_approval','awaiting_approval'),workerEvidence:evidence('approval'),validation:validation(true),reviewerRecommendation:{id:'recommendation-approval',provenance:'simulated_fixture',verdict:'recommend',rationale:'The retry bound, cancellation handling, and error context are correct and the configured checks passed.',createdAt:now}}]},
];
const streamEvents=[{id:'e7',type:'assignment.progress',entityType:'assignment',entityId:'worker-active',at:'2026-09-29T13:58:10.000Z',data:{assignmentId:'worker-active',roleId:'worker',model:'claude-sonnet-4',activity:{summary:'Added an abort-aware retry limit; preserving the existing error context.'}}},{id:'e8',type:'response.activity',entityType:'assignment',entityId:'worker-active',at:'2026-09-29T13:58:42.000Z',data:{assignmentId:'worker-active',roleId:'worker',model:'claude-sonnet-4',response:{activity:{summary:'Checking cancellation behavior and the focused retry tests.'}}}},{id:'e9',type:'assignment.progress',entityType:'assignment',entityId:'orchestrator-active',at:'2026-09-29T13:57:10.000Z',data:{assignmentId:'orchestrator-active',roleId:'orchestrator',model:'gpt-5',activity:{summary:'Coordinating the bounded retry implementation and its checks.'}}}];
const state={projects:[{id:'proj-atlas',name:'Atlas API',repoPath:'/workspace/atlas-api',status:'ready',plannerTurnCount:4,plannerMessages:[{id:'pm1',role:'user',text:'Improve retry reliability while preserving request cancellation.',createdAt:'2026-09-29T13:50:00Z'},{id:'pm2',role:'planner',text:'I split the work into retry limits, timeout handling, and user-facing diagnostics.',createdAt:'2026-09-29T13:51:00Z'}],plannerAssignments:[{id:'planner-assignment',roleId:'planner',status:'succeeded',createdAt:'2026-09-29T13:50:00Z',requestedConfig:{harnessId:'claude-code',model:'claude-sonnet-4'},result:'Split the retry reliability work into bounded attempts, timeout handling, and diagnostics.'}],usage:{inputTokens:32400,outputTokens:6100,totalTokens:38500,thinkingTokens:9200,cachedInputTokens:12000,runtimeMs:184000,requestCount:15,measured:true},tasks}],roles:[{id:'planner',name:'Planner',enabled:true},{id:'orchestrator',name:'Orchestrator',enabled:true},{id:'worker',name:'Worker',enabled:true},{id:'reviewer',name:'Reviewer',enabled:true}],events:[...events,...streamEvents]};
const github={available:true,remoteUrl:'https://github.com/acme/atlas-api',repository:'acme/atlas-api',account:'alex-dev',message:'No pull request is linked to this result branch.',taskBranch:undefined,taskCommit:undefined,remoteBranchSha:null,remoteBranchStatus:'missing'};
const systemChrome=process.env.CHROME_PATH??(await fs.access('/usr/bin/google-chrome').then(()=>'/usr/bin/google-chrome').catch(()=>undefined));
const browser=await chromium.launch({headless:true, ...(systemChrome?{executablePath:systemChrome}:{}), args:['--no-sandbox']});
const baseUrl=process.env.BASE_URL??'http://127.0.0.1:5173/';
const out=process.env.SCREEN_DIR??path.join(docsDir,'before');
const metricsPath=process.env.METRICS_PATH??'/tmp/foreman-ui-cleanup/metrics.jsonl';
await fs.mkdir(out,{recursive:true});await fs.mkdir(path.dirname(metricsPath),{recursive:true});
const captureScreenshots=process.env.CAPTURE_SCREENSHOTS!=='0';
const widths=(process.env.WIDTHS??'1024,1440,1920').split(',').map(Number);
const themes=(process.env.THEMES??'dark,light').split(',');
const scenarios=[['idle','Document retry behavior'],['active','Bound API retries safely'],['failed','Add request timeout guard'],['approval','Preserve upstream error details']];
const selectedScenarios=process.env.STATES?scenarios.filter(([key])=>process.env.STATES.split(',').includes(key)):scenarios;
for(const width of widths){
 for(const theme of themes){
  for(const [key,title] of selectedScenarios){
   const context=await browser.newContext({viewport:{width,height:1050},deviceScaleFactor:1});
   const page=await context.newPage(); const apiCalls=[];
   const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
   let githubMode='base';
   const resultCommit='c7a30d4f33b2e89b66dc0284f1aee75fc12a8b55';
   const fixtureGithub=()=>{
    const result={...github};
    if(githubMode==='base') return result;
    result.taskBranch='foreman/task-preserve-upstream-error-details'; result.taskCommit=resultCommit;
    if(githubMode==='unpromoted-matching'){result.remoteBranchStatus='matching';result.remoteBranchSha=resultCommit;return result;}
    if(githubMode==='promoted-missing'){result.remoteBranchStatus='missing';result.remoteBranchSha=null;return result;}
    if(githubMode==='promoted-different'){result.remoteBranchStatus='different';result.remoteBranchSha='d34db33fd34db33fd34db33fd34db33fd34db33f';return result;}
    result.remoteBranchStatus='matching';result.remoteBranchSha=resultCommit;return result;
   };
   await page.addInitScript((theme)=>{localStorage.setItem('foreman-theme',theme);},theme);
   await page.route('**/api/**',async route=>{
    const req=route.request(), url=new URL(req.url()), method=req.method(), path=url.pathname; apiCalls.push(`${method} ${path}`);
    if(path==='/api/events') return route.fulfill({status:200,headers:{'content-type':'text/event-stream','cache-control':'no-cache'},body:'data: {"type":"fixture.ready"}\n\n'});
    if(path==='/api/state') {
     const snapshot=structuredClone(state);
     if(githubMode.startsWith('promoted-')){
      const run=snapshot.projects[0].tasks.find(task=>task.id==='task-approval').runs[0];
      run.status='completed';
      run.approval={id:'approval-approval',approved:true,decision:'approved',evidenceCommit:run.pinnedBaseCommit,evidenceDigest:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',rationale:'Approved deterministic browser fixture.',createdAt:now};
      run.promotion={status:'applied',resultCommit:resultCommit,destinationBranch:'foreman/task-preserve-upstream-error-details',evidenceDigest:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',updatedAt:now};
     }
     return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(snapshot)});
    }
    if(path==='/api/status') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({uhp:{status:'ready',configured:true},memory:{status:'ready',configured:true}})});
    if(path==='/api/runs/run-approval/decision') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({runId:'run-approval',evidenceDigest:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',pinnedBaseCommit:'3b8f4c210a7751519cb06413aa4a5190bc4c4f2e',workerResponseId:'response-approval',validationId:'validation-ok',recommendationId:'recommendation-approval'})});
    if(path==='/api/projects/proj-atlas/usage') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({harnesses:[{harnessId:'claude-code',status:'ready',windows:{fiveHour:{status:'available',usedPercent:35,remainingPercent:65,resetAt:'2026-09-29T17:00:00.000Z',observedAt:now},weekly:{status:'available',usedPercent:42,remainingPercent:58,resetAt:'2026-10-05T00:00:00.000Z',observedAt:now}}},{harnessId:'codex-cli',status:'ready',windows:{fiveHour:{status:'available',usedPercent:58,remainingPercent:42,resetAt:'2026-09-29T17:30:00.000Z'},weekly:{status:'available',usedPercent:27,remainingPercent:73,resetAt:'2026-10-05T00:00:00.000Z'}}}]})});
    if(path==='/api/tasks/task-idle/start-preview') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({taskId:'task-idle',requiresExplicitBase:false,canStart:true,scope:['docs/api/retries.md'],validationCriteria:['Document the maximum attempt count','Explain timeout and cancellation behavior'],validationCommands:[{name:'Docs lint',command:'pnpm',args:['docs:check']}],budgets:{roleTurns:{planner:3,orchestrator:3,worker:2,reviewer:2},workerAttempts:2},currentHead:'3b8f4c210a7751519cb06413aa4a5190bc4c4f2e'})});
    const m=path.match(/^\/api\/runs\/([^/]+)\/github$/);
    if(m) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(fixtureGithub())});
    if(method!=='GET'&&method!=='HEAD') {apiCalls.push(`WRITE ${method} ${path}`);return route.fulfill({status:200,contentType:'application/json',body:'{}'});}
    return route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({error:`Unstubbed fixture endpoint ${path}`})});
   });
   await page.goto(baseUrl);
   const initialTheme=await page.evaluate(()=>document.documentElement.dataset.theme);
   const expectedThemeToggle=theme==='light'?'Switch to dark theme':'Switch to light theme';
   const actualThemeToggle=await page.getByRole('button',{name:/Switch to (dark|light) theme/}).getAttribute('aria-label');
   if(initialTheme!==theme||actualThemeToggle!==expectedThemeToggle)throw new Error(`Theme initialization failed: wanted ${theme}/${expectedThemeToggle}, got ${initialTheme}/${actualThemeToggle}`);
   await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}'});
   await page.locator('.usage-dock-more').evaluate(el=>{el.open=true});
   await page.getByRole('button',{name:title, exact:false}).first().click();
   await page.waitForTimeout(350);
   if(key!=='idle') await page.getByRole('button',{name:/Run Awaiting Approval|Run In Progress|Run Failed|Run/}).first().click().catch(()=>{});
   await page.waitForTimeout(250);
   if(key==='failed') {const summary=page.locator('.validation-progress');if(await summary.count())await summary.scrollIntoViewIfNeeded();const failure=page.locator('.validation-progress details').filter({hasText:'API contract'}).first();if(await failure.count()&&!await failure.evaluate(el=>el.open))await failure.locator('summary').click();}
   if(key==='approval') {const panel=page.locator('.decision-panel').first();if(await panel.count())await panel.scrollIntoViewIfNeeded();if(captureScreenshots&&width===1440&&await panel.count())await page.screenshot({path:`${out}/approval-${theme}-${width}-review.jpeg`,type:'jpeg',quality:80,fullPage:false});const human=page.locator('.evidence-block').filter({has:page.locator('summary b', {hasText:'Human decision'})}).first();if(await human.count()){await human.locator('summary').click();const decision=human.locator('.decision-actions').first();if(await decision.count())await decision.scrollIntoViewIfNeeded();}}
   // Confirm fixture is stable and capture the complete app plus dedicated scroll panels.
   const filename=`${key}-${theme}-${width}.jpeg`;
   if(captureScreenshots)await page.screenshot({path:`${out}/${filename}`,type:'jpeg',quality:80,fullPage:true});
   const overflow=await page.evaluate(()=>{const names=['.layout','.tree-content','.center','.inspector-scroll','.github-scroll','.usage-dock'];return {doc:document.documentElement.scrollWidth>document.documentElement.clientWidth,body:document.body.scrollWidth>document.body.clientWidth,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,containers:Object.fromEntries(names.map(name=>{const el=document.querySelector(name);if(!el)return[name,null];const box=el.getBoundingClientRect();return[name,{clientWidth:el.clientWidth,scrollWidth:el.scrollWidth,clientHeight:el.clientHeight,scrollHeight:el.scrollHeight,horizontalOverflow:el.scrollWidth>el.clientWidth,verticalOverflow:el.scrollHeight>el.clientHeight,visible:box.width>0&&box.height>0}]}))}});
   if(width===1440){
    if(captureScreenshots)await page.screenshot({path:`${out}/${key}-${theme}-${width}-viewport.jpeg`,type:'jpeg',quality:80,fullPage:false});
    if(captureScreenshots&&theme==='dark'&&key==='failed') {const el=page.locator('.center').first();if(await el.count())await el.screenshot({path:`${out}/failed-dark-${width}-center.jpeg`,type:'jpeg',quality:80});}
    if(captureScreenshots&&theme==='dark'&&key==='approval') {const el=page.locator('.center').first();if(await el.count())await el.screenshot({path:`${out}/approval-dark-${width}-center.jpeg`,type:'jpeg',quality:80});const aside=page.locator('.github-card').first();if(await aside.count())await aside.screenshot({path:`${out}/approval-dark-${width}-github.jpeg`,type:'jpeg',quality:80});}
   }
   if(pageErrors.length)throw new Error(`Page errors in ${key}/${theme}/${width}: ${pageErrors.join(' | ')}`);
   const unexpectedWrites=apiCalls.filter(call=>call.startsWith('WRITE'));
   if(unexpectedWrites.length)throw new Error(`Unexpected fixture write during ${key}/${theme}/${width}: ${unexpectedWrites.join(', ')}`);
   await fs.appendFile(metricsPath,JSON.stringify({key,theme,width,overflow,calls:apiCalls,pageErrors,initialTheme,themeToggle:actualThemeToggle})+'\n');
   if(process.env.RUN_INTERACTION_CHECKS==='1'&&width===1440&&theme==='dark'&&key==='approval'){
    const gateResults=[];
    const clickOpenPr=async(mode,expectedDisabled,reasonFragment)=>{
     githubMode=mode;await page.goto(baseUrl);await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}'});
     await page.getByRole('button',{name:'Preserve upstream error details',exact:false}).first().click();await page.waitForTimeout(150);
     await page.getByRole('button',{name:/Run Awaiting Approval|Run Completed|Run/}).first().click().catch(()=>{});
     await page.waitForFunction(()=>document.querySelector('.github-scroll')?.innerText.includes('Open PR'));
     const button=page.getByRole('button',{name:'Open PR',exact:true});await button.waitFor({state:'visible'});
     const disabled=await button.isDisabled();
     const reason=await page.locator('#github-open-pr-reason').textContent().catch(()=>null);
     let clickOutcome='';
     if(expectedDisabled){try{await button.click({timeout:500});clickOutcome='click unexpectedly succeeded';}catch{clickOutcome='browser refused disabled click';}}
     else {await button.click();await page.getByRole('dialog').waitFor({state:'visible'});clickOutcome='confirmation dialog opened';}
     const dialog=await page.getByRole('dialog').count()>0;
     if(disabled!==expectedDisabled)throw new Error(`${mode}: expected disabled=${expectedDisabled}, received ${disabled}`);
     if(reasonFragment&&!(reason??'').includes(reasonFragment))throw new Error(`${mode}: expected reason containing ${reasonFragment}; received ${reason}`);
     if(expectedDisabled&&dialog)throw new Error(`${mode}: disabled Open PR opened a confirmation dialog`);
     const writes=apiCalls.filter(call=>call.startsWith('WRITE'));
     if(writes.length)throw new Error(`${mode}: unexpected fixture write ${writes.join(', ')}`);
     gateResults.push({scenario:mode,disabled,reason,clickOutcome,dialog,writes});
    };
    await clickOpenPr('unpromoted-matching',true,'Promote the approved result');
    await clickOpenPr('promoted-missing',true,'Push the promoted result branch');
    await clickOpenPr('promoted-different',true,'remote branch differs');
    await clickOpenPr('promoted-matching',false,undefined);
    const gatePath=process.env.GATE_RESULTS_PATH??'/tmp/foreman-ui-cleanup/pr-gate-results.json';await fs.mkdir(path.dirname(gatePath),{recursive:true});await fs.writeFile(gatePath,JSON.stringify(gateResults,null,2)+'\n');
    githubMode='base';await page.goto(baseUrl);await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}'});await page.keyboard.press('Tab');
    const focusProbe=await page.evaluate(()=>{const el=document.activeElement;if(!el)return null;const style=getComputedStyle(el);return {tag:el.tagName,ariaLabel:el.getAttribute('aria-label'),text:el.textContent?.trim().slice(0,80),outlineStyle:style.outlineStyle,outlineWidth:style.outlineWidth,outlineColor:style.outlineColor,focusVisible:el.matches(':focus-visible')}});
    const focusPath=process.env.FOCUS_RESULTS_PATH?.replace(/\.json$/,`-${theme}.json`)??`/tmp/foreman-ui-cleanup/focus-${theme}.json`;await fs.mkdir(path.dirname(focusPath),{recursive:true});
    await fs.writeFile(focusPath,JSON.stringify({theme,width,focusProbe},null,2)+'\n');
   }
   if(width===1440&&theme==='light'&&key==='approval'){
    await page.goto(baseUrl);await page.keyboard.press('Tab');
    const focusProbe=await page.evaluate(()=>{const el=document.activeElement;if(!el)return null;const style=getComputedStyle(el);return {tag:el.tagName,ariaLabel:el.getAttribute('aria-label'),text:el.textContent?.trim().slice(0,80),outlineStyle:style.outlineStyle,outlineWidth:style.outlineWidth,outlineColor:style.outlineColor,focusVisible:el.matches(':focus-visible')}});
    const focusPath=process.env.FOCUS_RESULTS_PATH?.replace(/\.json$/,`-${theme}.json`)??`/tmp/foreman-ui-cleanup/focus-${theme}.json`;await fs.mkdir(path.dirname(focusPath),{recursive:true});
    await fs.writeFile(focusPath,JSON.stringify({theme,width,focusProbe},null,2)+'\n');
   }
   await context.close();
  }
 }
}
await browser.close();
