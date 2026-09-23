import React, { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Guidance = { id: string; sequence?: number; text: string; status?: string; createdAt?: string };
type Assignment = { id: string; roleId: string; status?: string; submissionId?: string; requestedConfig?: unknown; actualConfig?: unknown; prompt?: string; result?: unknown; error?: string };
type Run = { id: string; status?: string; plannerSessionId?: string; orchestratorSessionId?: string; guidance?: Guidance[]; assignments?: Assignment[]; createdAt?: string; updatedAt?: string };
type Task = { id: string; title: string; status?: string; runs?: Run[] };
type Project = { id: string; name: string; status?: string; tasks?: Task[] };
type Role = { id: string; name: string; enabled: boolean; configSchema?: unknown; config?: unknown };
type EventItem = { id: string; type: string; entityType?: string; entityId?: string; at: string; data?: Record<string, unknown> };
type State = { projects: Project[]; roles?: Role[]; events?: EventItem[] };

const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.status === 204 ? undefined as T : response.json();
};
const label = (value?: string) => value ? value.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Unknown';
const stamp = (value?: string) => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

function App() {
  const [state, setState] = useState<State>({ projects: [], roles: [], events: [] });
  const [selectedProject, setSelectedProject] = useState('');
  const [selectedTask, setSelectedTask] = useState('');
  const [selectedRun, setSelectedRun] = useState('');
  const [view, setView] = useState<'overview'|'run'>('overview');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(false);
  const [eventCount, setEventCount] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const next = await api<State>('/api/state');
      setState({ projects: next.projects ?? [], roles: next.roles ?? [], events: next.events ?? [] });
      setOnline(true); setError('');
    } catch (e) { setOnline(false); setError(e instanceof Error ? e.message : 'Could not load state'); }
  }, []);
  useEffect(() => { void refresh(); const timer = window.setInterval(refresh, 15000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onopen = () => setOnline(true);
    source.onmessage = () => { setEventCount(v => v + 1); void refresh(); };
    for (const type of ['project.created','task.created','run.created','guidance.added','guidance.acknowledged','assignment.submission_intent','assignment.submitted','assignment.submit_failed','assignment.cancel_intent','assignment.cancel_result']) source.addEventListener(type, () => { setEventCount(v => v + 1); void refresh(); });
    source.onerror = () => setOnline(false);
    return () => source.close();
  }, [refresh]);

  const project = state.projects.find(p => p.id === selectedProject) ?? state.projects[0];
  const task = project?.tasks?.find(t => t.id === selectedTask) ?? project?.tasks?.[0];
  const run = task?.runs?.find(r => r.id === selectedRun) ?? task?.runs?.[0];
  useEffect(() => { if (project && project.id !== selectedProject) setSelectedProject(project.id); }, [project?.id]);
  useEffect(() => { if (task && task.id !== selectedTask) setSelectedTask(task.id); }, [task?.id]);
  useEffect(() => { if (run && run.id !== selectedRun) setSelectedRun(run.id); }, [run?.id]);

  const totals = useMemo(() => ({ projects: state.projects.length, tasks: state.projects.reduce((n,p)=>n+(p.tasks?.length ?? 0),0), runs: state.projects.reduce((n,p)=>n+(p.tasks?.reduce((m,t)=>m+(t.runs?.length ?? 0),0) ?? 0),0) }), [state.projects]);
  const create = async (kind: 'projects'|'tasks'|'runs', name?: string) => {
    setPending(true); setError('');
    try {
      const path = kind === 'projects' ? '/api/projects' : kind === 'tasks' ? `/api/projects/${project?.id}/tasks` : `/api/tasks/${task?.id}/runs`;
      await api(path, { method: 'POST', body: JSON.stringify(kind === 'runs' ? {} : kind === 'tasks' ? { title: name } : { name }) });
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create item'); }
    finally { setPending(false); }
  };
  const submitGuidance = async (e: FormEvent) => {
    e.preventDefault(); if (!run || !message.trim()) return;
    setPending(true); setError('');
    try { await api(`/api/runs/${run.id}/guidance`, { method: 'POST', body: JSON.stringify({ text: message.trim() }) }); setMessage(''); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not send guidance'); }
    finally { setPending(false); }
  };
  const addProject = () => { const name = window.prompt('Project name'); if (name?.trim()) void create('projects', name.trim()); };
  const addTask = () => { const title = window.prompt('Task title'); if (title?.trim()) void create('tasks', title.trim()); };

  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">F</span><div><strong>Foreman <i>v2</i></strong><small>Local Engineering Control Plane</small></div></div>
      <div className="crumbs"><span>Projects</span><b>›</b><span>{project?.name ?? 'Workspace'}</span><b>›</b><span>{task?.title ?? 'Overview'}</span></div>
      <div className="system"><span className={`dot ${online?'green':'muted'}`}/>{online ? 'Local system online' : 'Connecting to local system'}</div>
      <button className="icon-button" title="Refresh state" onClick={() => void refresh()}>↻</button>
    </header>
    <nav className="rail">{[['▦','Projects'],['◷','Runs'],['♙','Roles'],['▤','Events'],['⌁','Usage']].map(([icon,name],i)=><button key={name} className={i===0?'active':''} onClick={()=>i===3&&document.getElementById('events')?.scrollIntoView({behavior:'smooth'})}><span>{icon}</span>{name}</button>)}<div className="rail-bottom"><span className={`dot ${online?'green':'muted'}`}/>Local process<br/><small>{online?'Connected':'Unavailable'}</small></div></nav>
    <main>
      <section className="heading"><div><div className="eyebrow">WORKSPACE / {project?.id ?? 'NO PROJECT'}</div><h1>{project?.name ?? 'Your workspace'}</h1><p>{project ? 'Plan, coordinate, and inspect local engineering work.' : 'Create a project to start organizing work.'}</p></div><div className="metrics"><div><b>{totals.tasks}</b><span>Tasks</span></div><div><b>{totals.runs}</b><span>Runs</span></div><div><b>{state.roles?.length ?? 0}</b><span>Roles</span></div><button className="primary small" onClick={addProject} disabled={pending}>＋ New project</button></div></section>
      {error && <div className="error"><span>Could not complete request: {error}</span><button onClick={()=>setError('')}>Dismiss</button></div>}
      <div className="layout">
        <aside className="tree card">
          <div className="card-title"><div><span className="overline">HIERARCHY</span><h2>Project tree</h2></div><button className="outline small" onClick={addProject}>＋ New</button></div>
          {state.projects.length === 0 ? <div className="empty"><span className="empty-icon">▱</span><b>No projects yet</b><p>Create a project to establish the workspace hierarchy.</p><button className="primary small" onClick={addProject}>Create project</button></div> : state.projects.map(p=><div key={p.id} className="project-node">
            <button className={`node project ${project?.id===p.id?'selected':''}`} onClick={()=>{setSelectedProject(p.id);setSelectedTask('');setSelectedRun('');setView('overview')}}><span className="folder">▰</span><b>{p.name}</b><span className="node-count">{p.tasks?.length ?? 0}</span></button>
            {project?.id===p.id && <div className="children">{p.tasks?.map(t=><div key={t.id}>
              <button className={`node task ${task?.id===t.id?'selected':''}`} onClick={()=>{setSelectedTask(t.id);setSelectedRun('');setView('overview')}}><span className="task-icon">◉</span><span className="truncate">{t.title}</span><span className="node-count">{t.runs?.length ?? 0}</span></button>
              {task?.id===t.id && <div className="runs">{t.runs?.map(r=><button key={r.id} className={`node run ${run?.id===r.id?'selected':''}`} onClick={()=>{setSelectedRun(r.id);setView('run')}}><span className={`status-ring ${r.status==='running'?'busy':''}`}/><span>Run <code>{r.id.slice(0,8)}</code></span><span className={`pill ${r.status==='running'?'live':''}`}>{label(r.status)}</span></button>)}<button className="add-run" onClick={()=>void create('runs')} disabled={pending}>＋ Start run</button></div>}
            </div>)}<button className="add-task" onClick={addTask}>＋ Add task</button></div>}
          </div>)}
          <div className="tree-foot"><span className="dot green"/> Hierarchy from local state</div>
        </aside>
        <section className="center">
          <div className="conversation card">
            <div className="card-title convo-heading"><div className="title-icon planner-icon">✦</div><div><span className="overline">PRIMARY CONVERSATION SURFACE</span><h2>{view==='run'?'Steer this run':'Talk to the Planner'}</h2><p>{view==='run'?'Give guidance to the Planner. It coordinates the team.':'Describe the outcome. The Planner will shape and coordinate the work.'}</p></div><span className="badge blue">Planner</span></div>
            <div className="chat" aria-live="polite">
              {!run ? <div className="welcome"><span className="spark">✦</span><h3>Start with a conversation</h3><p>Create a task and run, then guide the Planner here. Your messages steer the work.</p></div> : <>
                <div className="system-note"><span className="dot green"/> Run <code>{run.id}</code> · {label(run.status)}{run.updatedAt ? ` · updated ${stamp(run.updatedAt)}` : ''}</div>
                {(run.guidance ?? []).length === 0 ? <div className="welcome compact"><span className="spark">✦</span><h3>Give the Planner direction</h3><p>No guidance has been recorded for this run yet.</p></div> : [...(run.guidance ?? [])].sort((a,b)=>(a.sequence??0)-(b.sequence??0)).map((g,i)=><article className="message" key={g.id}><div className="avatar user-avatar">Y</div><div className="message-content"><div className="message-meta"><b>You</b><span>{g.createdAt ? stamp(g.createdAt) : `Guidance ${i+1}`}</span><span className="pill subtle">{label(g.status ?? 'recorded')}</span></div><div className="bubble">{g.text}</div></div></article>)}
                {run.assignments?.length ? <div className="assignment-summary"><span className="overline">CURRENT ASSIGNMENTS</span>{run.assignments.map(a=><details className="assignment-detail" key={a.id}><summary className="assignment"><span className="role-glyph">{a.roleId.slice(0,1).toUpperCase()}</span><b>{label(a.roleId)}</b><span className={`pill ${a.status==='running'?'live':''}`}>{label(a.status)}</span></summary><div className="assignment-inspect">{a.prompt&&<p>{a.prompt}</p>}<div><span>Submission</span><code>{a.submissionId??'Unavailable'}</code></div><div><span>Requested config</span><code>{a.requestedConfig===undefined?'Unavailable':JSON.stringify(a.requestedConfig)}</code></div><div><span>Actual config</span><code>{a.actualConfig===undefined?'Unavailable':JSON.stringify(a.actualConfig)}</code></div>{a.error&&<div className="assignment-error">{a.error}</div>}</div></details>)}</div> : null}
              </>}
            </div>
            <form className="composer" onSubmit={submitGuidance}><textarea value={message} onChange={e=>setMessage(e.target.value)} placeholder={run?'Send guidance to the Planner…':'Select a run to send guidance…'} disabled={!run||pending} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.currentTarget.form?.requestSubmit()}}}/><div className="compose-actions"><span className="compose-hint">Guidance is recorded on the selected run · Shift + Enter for new line</span><button className="primary" disabled={!run||!message.trim()||pending}>{pending?'Sending…':'➤  Send guidance'}</button></div></form>
          </div>
          <section className="orchestrator card"><div className="card-title"><div><span className="overline">EXECUTION CONTROL</span><h2>Orchestrator plan &amp; state</h2></div><span className={`badge ${run?.status==='running'?'green-badge':''}`}><span className="dot green"/>{run ? label(run.status) : 'No active run'}</span></div>
            {!run ? <div className="plan-empty">Create a task and run to see orchestration state here.</div> : <><div className="flow">{['Planner','Worker','Reviewer'].map((name,i)=><React.Fragment key={name}><div className="flow-card"><div className={`flow-icon flow-${i}`}>{['✦','⌘','⌕'][i]}</div><div className="flow-main"><b>{name}</b><span>{i===0?'Plans and coordinates':i===1?'Executes assigned work':'Reviews the result'}</span></div><span className={`pill ${i===0&&run.status==='running'?'live':''}`}>{i===0?label(run.status):'Awaiting state'}</span></div>{i<2&&<span className="flow-arrow">→</span>}</React.Fragment>)}</div><div className="run-meta"><div><span className="overline">PLANNER SESSION</span><code>{run.plannerSessionId ?? 'Unavailable'}</code></div><div><span className="overline">ORCHESTRATOR SESSION</span><code>{run.orchestratorSessionId ?? 'Unavailable'}</code></div><div><span className="overline">USAGE</span><b className="unknown">Unavailable</b></div></div></>}
          </section>
        </section>
        <aside className="inspector">
          <section className="card inspector-card"><div className="card-title"><div><span className="overline">SELECTED RUN</span><h2>Run details</h2></div><span className="number-badge">1</span></div>{run ? <><div className="detail-row"><span>Status</span><b><span className="dot green"/>{label(run.status)}</b></div><div className="detail-row"><span>Run ID</span><code>{run.id}</code></div><div className="detail-row"><span>Guidance entries</span><b>{run.guidance?.length ?? 0}</b></div><div className="detail-row"><span>Assignments</span><b>{run.assignments?.length ?? 0}</b></div><div className="detail-row"><span>Usage</span><b className="unknown">Unavailable</b></div></> : <div className="aside-empty">Choose or start a run to inspect its state.</div>}</section>
          <section className="card inspector-card"><div className="card-title"><div><span className="overline">CONFIGURED ROLES</span><h2>Roles</h2></div><span className="count-badge">{state.roles?.length ?? 0}</span></div>{state.roles?.length ? state.roles.map(r=><div className="role-row" key={r.id}><span className="role-icon">{r.name.slice(0,1).toUpperCase()}</span><div><b>{r.name}</b><small>{r.enabled?'Enabled':'Disabled'} · Configuration {r.config?'present':'not reported'}</small></div><span className={`dot ${r.enabled?'green':'muted'}`}/></div>) : <div className="aside-empty">No roles reported by local state.</div>}</section>
          <section className="card inspector-card usage-card"><div className="card-title"><div><span className="overline">TRANSPARENCY</span><h2>Usage &amp; evidence</h2></div><span className="shield">◇</span></div><div className="usage-empty"><span className="usage-symbol">⌁</span><b>Usage unavailable</b><p>No measured or estimated token, model, or cost data is exposed by the current API.</p><div className="legend"><span><i className="measured"/>Measured</span><span><i className="estimated"/>Estimated</span><span><i className="unavailable"/>Unavailable</span></div></div></section>
          <section className="card inspector-card events-card" id="events"><div className="card-title"><div><span className="overline">LIVE ACTIVITY</span><h2>Recent events</h2></div><span className="count-badge">{eventCount}</span></div>{state.events?.slice(-5).reverse().map(ev=><div className="event-row" key={ev.id}><span className="event-dot"/><div><b>{label(ev.type)}</b><small>{ev.entityType ? `${label(ev.entityType)} · ` : ''}{ev.entityId ?? 'System'}</small></div><time>{stamp(ev.at)}</time></div>)}{!state.events?.length&&<div className="aside-empty">Waiting for events from the local system.</div>}</section>
        </aside>
      </div>
      <footer>Foreman v2 <span>·</span> Local control plane <span>·</span> Live events {online?'connected':'disconnected'} <span className="foot-right">Usage values appear only when the system reports them.</span></footer>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
