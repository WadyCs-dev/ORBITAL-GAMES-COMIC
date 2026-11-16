import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { cloudClient } from '../collaboration/client';
import { connectLiveTeam, disconnectLiveTeam, sendLiveMessage, setLiveReady, startLiveMission, useLiveSession, type LiveSnapshot } from '../collaboration/liveSession';
import { captureCampaign, parseCampaignSnapshot, restoreCampaign, type CampaignSnapshot } from '../collaboration/campaignSnapshot';
import { parseDesignSnapshot } from '../systems/designSnapshot';
import { readStorage } from '../systems/storage';
import type { MissionDesign } from '../systems/engineering';
import type { Mission } from '../data/missions';
import type { ShipId } from '../data/ships';
import './mission-systems.css';
import './collaboration.css';

type Props = { language: 'en' | 'es'; mission: Mission; shipId: ShipId; design: MissionDesign; onExit: () => void; onApply: (id: string, design: MissionDesign) => boolean };
type Team = { id: string; name: string; owner_id: string; created_at: string };
type Member = { user_id: string; role: string };
type Plan = { team_id: string; mission_id: string; design: unknown; revision: number; updated_at: string };
type CloudRecord = { snapshot: unknown; revision: number; updated_at: string };

function sameLivePanel(left: LiveSnapshot, right: LiveSnapshot) {
 if(left.connected!==right.connected || left.error!==right.error || left.hostId!==right.hostId || left.refreshVersion!==right.refreshVersion || left.authoritativeSession?.revision!==right.authoritativeSession?.revision || left.players.length!==right.players.length || left.messages.length!==right.messages.length) return false;
 if(left.players.some((player,index)=>{const next=right.players[index];return !next || player.userId!==next.userId || player.displayName!==next.displayName || player.role!==next.role || player.isHost!==next.isHost || player.connected!==next.connected || player.ready!==next.ready || player.pose.activity!==next.pose.activity;}))return false;
 return left.messages.at(-1)?.id===right.messages.at(-1)?.id;
}

export default function CollaborationHub({ language, mission, shipId, design, onExit, onApply }: Props) {
 const t = (es: string, en: string) => language === 'es' ? es : en;
 const [session,setSession]=useState<Session|null>(null); const [authReady,setAuthReady]=useState(false);
 const [email,setEmail]=useState(''); const [password,setPassword]=useState('');
 const [username,setUsername]=useState(''); const [firstName,setFirstName]=useState(''); const [lastName,setLastName]=useState(''); const [status,setStatus]=useState(''); const [statusIsAlert,setStatusIsAlert]=useState(false); const [busy,setBusy]=useState(false);
 const [teams,setTeams]=useState<Team[]>([]); const [teamId,setTeamId]=useState(''); const [members,setMembers]=useState<Member[]>([]); const [plan,setPlan]=useState<Plan|null>(null);
 const [teamName,setTeamName]=useState(''); const [joinCode,setJoinCode]=useState(''); const [invite,setInvite]=useState('');
 const live=useLiveSession((value)=>value,sameLivePanel);
 const [teamCampaign,setTeamCampaign]=useState<(CloudRecord & {team_id:string}) | null>(null); const [teamCampaignReady,setTeamCampaignReady]=useState(false);
 const [cloud,setCloud]=useState<CloudRecord|null>(null); const [cloudReady,setCloudReady]=useState(false); const [autoSave,setAutoSave]=useState(false);
 const revisionRef=useRef<number|null>(null); const lastSaved=useRef(''); const saving=useRef(false);
 useEffect(()=>{if(!session)return;const m=session.user.user_metadata ?? {};setUsername(typeof m.username==='string'?m.username:'');setFirstName(typeof m.first_name==='string'?m.first_name:'');setLastName(typeof m.last_name==='string'?m.last_name:'');},[session?.user.id]);
 const profileValid=[username,firstName,lastName].every(value=>value.trim().length>0 && value.trim().length<=48);
 const me=session?.user.id; const team=teams.find(item=>item.id===teamId); const myRole=members.find(item=>item.user_id===me)?.role ?? 'science';
 const displayName=typeof session?.user.user_metadata?.username==='string' ? session.user.user_metadata.username : session?.user.email?.split('@')[0] ?? 'Explorer';
 const errorText=(error: unknown) => error instanceof Error ? error.message : t('La operación no pudo completarse.', 'The operation could not be completed.');

 useEffect(()=>{
  const client=cloudClient; if(!client){setAuthReady(true);return;}
  let active=true; void client.auth.getSession().then(({data})=>{if(active){setSession(data.session);setAuthReady(true);}}).catch(()=>{if(active)setAuthReady(true);});
  const {data}=client.auth.onAuthStateChange((_event,next)=>{if(active){setSession(next);setAuthReady(true);}});
  return ()=>{active=false;data.subscription.unsubscribe();};
 },[]);
 useEffect(()=>{setTeams([]);setTeamId('');setMembers([]);setPlan(null);setTeamCampaign(null);setTeamCampaignReady(false);setInvite('');setCloud(null);setCloudReady(false);setAutoSave(false);revisionRef.current=null;lastSaved.current='';
  if(!me || !cloudClient)return; let active=true;
  void cloudClient.from('orbital_campaigns').select('snapshot,revision,updated_at').eq('user_id',me).maybeSingle().then(({data,error})=>{
   if(!active)return; if(error){setStatus(error.message);return;}
   if(data && (!Number.isInteger(data.revision) || !parseCampaignSnapshot(data.snapshot))){setStatus(t('La copia remota no es válida y no se restaurará.', 'The remote backup is invalid and will not be restored.'));return;}
   const row=data as CloudRecord|null; setCloud(row); revisionRef.current=row?.revision ?? -1; setCloudReady(true);
  });
  return ()=>{active=false;};
 // Language changes do not restart the authenticated session.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[me]);
 const refresh=useCallback(async()=>{
  if(!cloudClient || !me)return;
  const list=await cloudClient.from('orbital_teams').select('id,name,owner_id,created_at').order('created_at');
  if(list.error){setStatus(list.error.message);return;}
  const rows=(list.data ?? []) as Team[]; setTeams(rows);
  if(teamId && !rows.some(row=>row.id===teamId)){setTeamId('');setPlan(null);setMembers([]);setTeamCampaign(null);setTeamCampaignReady(false);return;}
  if(!teamId && rows.length){setTeamId(rows[0].id);return;}
  if(teamId){
   const [roster,current,campaign]=await Promise.all([cloudClient.from('orbital_team_members').select('user_id,role').eq('team_id',teamId),cloudClient.from('orbital_team_plans').select('team_id,mission_id,design,revision,updated_at').eq('team_id',teamId).maybeSingle(),cloudClient.from('orbital_team_campaigns').select('team_id,snapshot,revision,updated_at').eq('team_id',teamId).maybeSingle()]);
   if(roster.error || current.error || campaign.error){setStatus(roster.error?.message ?? current.error?.message ?? campaign.error?.message ?? '');return;}
   setMembers((roster.data ?? []) as Member[]);setPlan(current.data as Plan|null);setTeamCampaign(campaign.data as (CloudRecord & {team_id:string}) | null);setTeamCampaignReady(true);
  }
 },[me,teamId]);
 useEffect(()=>{if(!me)return;void refresh();const timer=window.setInterval(()=>void refresh(),5000);return()=>window.clearInterval(timer);},[me,refresh]);
 useEffect(()=>{if(live.refreshVersion>0)void refresh();},[live.refreshVersion,refresh]);
 useEffect(()=>{
  if(!team || !me || !cloudClient){void disconnectLiveTeam();return;}
  void connectLiveTeam({teamId:team.id,userId:me,displayName,role:myRole,hostId:team.owner_id});
  return ()=>{void disconnectLiveTeam();};
 },[team?.id,team?.owner_id,me,displayName,myRole]);
 const saveCampaign=useCallback(async()=>{
  if(!cloudClient || !me || revisionRef.current===null || saving.current)return;
  let snapshot: CampaignSnapshot;try{snapshot=captureCampaign(window.localStorage);}catch{setStatus(t('No se puede leer o guardar la campaña local.', 'The local campaign cannot be read or backed up.'));setAutoSave(false);return;}
  const serialised=JSON.stringify(snapshot);if(serialised===lastSaved.current)return;
  saving.current=true;const result=await cloudClient.rpc('orbital_save_campaign',{expected_revision:revisionRef.current,new_snapshot:snapshot});saving.current=false;
  if(result.error){setStatus(t('No se guardó la copia. Puede haber un conflicto con otro dispositivo; recarga y revisa antes de sobrescribir.', 'Backup not saved. Another device may have changed it; reload and review before overwriting.'));setAutoSave(false);return;}
  revisionRef.current=result.data as number;lastSaved.current=serialised;setCloud({snapshot,revision:result.data as number,updated_at:new Date().toISOString()});setStatus(t('Campaña guardada en Supabase.', 'Campaign saved to Supabase.'));
 // The current authenticated user controls this backup.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[me,language]);
 useEffect(()=>{if(!autoSave)return;void saveCampaign();const timer=window.setInterval(()=>void saveCampaign(),5000);const onHide=()=>{if(document.visibilityState==='hidden')void saveCampaign();};document.addEventListener('visibilitychange',onHide);return()=>{window.clearInterval(timer);document.removeEventListener('visibilitychange',onHide);};},[autoSave,saveCampaign]);
 async function authenticate(signUp: boolean) {
  if(!cloudClient)return;
  if(!email.trim()){setStatus(t('Escribe el correo al que tienes acceso.','Enter an email address you can access.'));setStatusIsAlert(true);return;}
  if(!password){setStatus(t('Escribe tu contraseña.','Enter your password.'));setStatusIsAlert(true);return;}
  if(signUp && !profileValid){setStatus(t('Completa usuario, nombre y apellido. Cada campo admite entre 1 y 48 caracteres.','Complete username, first name, and surname. Each field accepts 1 to 48 characters.'));setStatusIsAlert(true);return;}
  if(signUp && password.length<12){setStatus(t('La contraseña debe tener al menos 12 caracteres.','The password must contain at least 12 characters.'));setStatusIsAlert(true);return;}
  setBusy(true);setStatus('');setStatusIsAlert(false);
  try {
   const result=signUp ? await cloudClient.auth.signUp({email:email.trim(),password,options:{emailRedirectTo:new URL(import.meta.env.BASE_URL,window.location.href).href,data:{username:username.trim(),first_name:firstName.trim(),last_name:lastName.trim()}}}) : await cloudClient.auth.signInWithPassword({email:email.trim(),password});
   if(result.error)throw result.error;setPassword('');if(signUp){setStatus(t('Cuenta creada. Revisa tu correo (también Spam/Correo no deseado) y abre el enlace de confirmación antes de iniciar sesión.','Account created. Check your inbox (including Spam/Junk) and open the confirmation link before signing in.'));setStatusIsAlert(false);}
  }catch(error){
   const message=errorText(error).toLowerCase(); const code=error && typeof error==='object' && 'code' in error ? String(error.code).toLowerCase() : '';
   if(message.includes('invalid login credentials') || message.includes('invalid email or password'))setStatus(t('Correo o contraseña incorrectos. Revisa los datos o crea una cuenta nueva.', 'Email or password is incorrect. Check your details or create an account.'));
   else if(message.includes('email not confirmed'))setStatus(t('Tu correo aún no está confirmado. Abre el enlace que te enviamos y vuelve a iniciar sesión.', 'Your email is not confirmed yet. Open the link we sent and sign in again.'));
   else if(message.includes('already registered') || message.includes('user already exists') || code==='user_already_exists')setStatus(t('Ese correo ya tiene una cuenta. Cambia a “Ya tengo cuenta · Iniciar sesión”.','That email already has an account. Switch to “Already registered · Sign in”.'));
   else if(message.includes('weak password') || message.includes('password should') || code==='weak_password')setStatus(t('La contraseña no cumple el mínimo de seguridad. Usa al menos 12 caracteres.', 'The password does not meet the security minimum. Use at least 12 characters.'));
   else if(message.includes('rate limit') || message.includes('too many requests') || code.includes('rate_limit'))setStatus(t('Se enviaron demasiados intentos. Espera unos minutos y vuelve a intentarlo.', 'Too many attempts were made. Wait a few minutes and try again.'));
   else if(message.includes('signup') && (message.includes('disabled') || message.includes('not allowed')))setStatus(t('El registro está desactivado en Supabase. Activa “Allow new users to sign up” en Authentication → Settings.', 'Sign-up is disabled in Supabase. Enable “Allow new users to sign up” under Authentication → Settings.'));
   else if(message.includes('redirect') || message.includes('allow list') || message.includes('not allowed'))setStatus(t('Supabase rechazó el enlace de confirmación. Hay que permitir la URL de esta página en Authentication → URL Configuration → Redirect URLs.', 'Supabase rejected the confirmation link. Add this page URL under Authentication → URL Configuration → Redirect URLs.'));
   else if(message.includes('email address') && message.includes('invalid'))setStatus(t('Ese correo no parece válido. Revisa que tenga el formato nombre@dominio.com.', 'That email address looks invalid. Check that it uses the name@domain.com format.'));
   else if(message.includes('failed to fetch') || message.includes('network') || error instanceof TypeError)setStatus(t('No se pudo conectar con Supabase. Comprueba tu conexión e inténtalo de nuevo.', 'Could not connect to Supabase. Check your connection and try again.'));
   else setStatus(signUp?t('No se pudo crear la cuenta. Comprueba el correo y los campos; si continúa, revisa la configuración de registro y confirmación de correo en Supabase.', 'Could not create the account. Check the email and fields; if it continues, check sign-up and email-confirmation settings in Supabase.'):t('No se pudo iniciar sesión. Revisa el correo y la contraseña.', 'Could not sign in. Check your email and password.'));
   setStatusIsAlert(true);
  }finally{setBusy(false);}
 }
 async function saveProfile(){if(!cloudClient || !profileValid)return;setBusy(true);const {error}=await cloudClient.auth.updateUser({data:{username:username.trim(),first_name:firstName.trim(),last_name:lastName.trim()}});setBusy(false);setStatus(error?error.message:t('Perfil actualizado.','Profile updated.'));}
 async function createTeam(){if(!cloudClient)return;setBusy(true);const {data,error}=await cloudClient.rpc('orbital_create_team',{team_name:teamName});setBusy(false);if(error){setStatus(error.message);return;}const row=Array.isArray(data)?data[0]:null;if(row && typeof row.team_id==='string' && typeof row.invite_code==='string'){setInvite(row.invite_code);setTeamName('');setTeamId(row.team_id);}}
 async function joinTeam(){if(!cloudClient)return;if(!/^[0-9a-f]{32}$/.test(joinCode.trim())){setStatus(t('El código de invitación no es válido.', 'The invitation code is invalid.'));return;}setBusy(true);const {data,error}=await cloudClient.rpc('orbital_join_team',{code:joinCode.trim()});setBusy(false);if(error){setStatus(error.message);return;}setJoinCode('');setTeamId(String(data));}
 async function updateRole(role:string){if(!cloudClient || !teamId)return;const {error}=await cloudClient.rpc('orbital_set_role',{target_team:teamId,selected_role:role});if(error)setStatus(error.message);else await refresh();}
 async function publishPlan(){if(!cloudClient || !teamId || !plan || plan.team_id!==teamId)return;const snapshot=parseDesignSnapshot(readStorage(`orbital-command-design-v1-${mission.id}`) ?? '',mission.id);if(!snapshot){setStatus(t('Guarda primero un diseño para esta misión en Ingeniería.', 'First save a design for this mission in Engineering.'));return;}const {error}=await cloudClient.rpc('orbital_update_plan',{target_team:teamId,expected_revision:plan.revision,target_mission:mission.id,new_design:snapshot.design});if(error){setStatus(t('No se actualizó el plan. Puede haber cambiado; espera la actualización y vuelve a intentarlo.', 'The plan was not updated. It may have changed; wait for refresh and try again.'));await refresh();return;}setStatus(t('Plan compartido con el equipo.', 'Plan shared with the team.'));await refresh();}
 async function shareTeamCampaign(){if(!cloudClient || !teamId || !teamCampaignReady || teamCampaign && teamCampaign.team_id!==teamId)return;let snapshot:CampaignSnapshot;try{snapshot=captureCampaign(window.localStorage);}catch{setStatus(t('No se pudo leer la campaña local.', 'Could not read the local campaign.'));return;}const {error}=await cloudClient.rpc('orbital_save_team_campaign',{target_team:teamId,expected_revision:teamCampaign?.revision ?? -1,new_snapshot:snapshot});if(error){setStatus(t('La campaña compartida pudo cambiar; espera la actualización y vuelve a intentarlo.', 'The shared campaign may have changed; wait for refresh and try again.'));await refresh();return;}setStatus(t('Campaña compartida con el equipo.', 'Campaign shared with the team.'));await refresh();}
 async function rotateInvite(){if(!cloudClient || !teamId)return;const {data,error}=await cloudClient.rpc('orbital_rotate_invite',{target_team:teamId});if(error)setStatus(error.message);else setInvite(String(data));}
 async function exitTeam(){if(!cloudClient || !team || !me)return;const owner=team.owner_id===me;if(!window.confirm(owner?t('¿Eliminar el equipo y su plan para todos sus miembros?', 'Delete the team and its plan for every member?'):t('¿Salir de este equipo?', 'Leave this team?')))return;const {error}=await cloudClient.rpc(owner?'orbital_delete_team':'orbital_leave_team',{target_team:teamId});if(error){setStatus(error.message);return;}setTeamId('');setPlan(null);setTeamCampaign(null);setTeamCampaignReady(false);setInvite('');await refresh();}
 const parsedPlan=plan && plan.team_id===teamId ? parseDesignSnapshot(JSON.stringify({version:1,missionId:plan.mission_id,design:plan.design}),plan.mission_id) : null;
 return <section className="systems-screen collaboration-screen" aria-label={t('Cuentas y equipos', 'Accounts and teams')}><header className="systems-heading"><div><span>ORBITAL COMMAND · {t('COLABORACIÓN', 'COLLABORATION')}</span><h1>{t('Centro de equipos', 'Team centre')}</h1><p>{t('Guarda una copia privada de tu campaña y comparte planes de misión con hasta cuatro participantes.', 'Back up your private campaign and share mission plans with up to four participants.')}</p></div><button className="systems-secondary" onClick={onExit}>{t('← VOLVER','← BACK')}</button></header>
 {!cloudClient ? <div className="systems-card"><h2>{t('Servicio no configurado', 'Service not configured')}</h2><p>{t('La cuenta y los equipos necesitan un proyecto Supabase conectado. La campaña local sigue disponible.', 'Accounts and teams require a connected Supabase project. The local campaign remains available.')}</p></div> : !authReady ? <p role="status">{t('Comprobando la sesión…', 'Checking session…')}</p> : !session ? <AccountAuthPanel language={language} busy={busy} email={email} password={password} username={username} firstName={firstName} lastName={lastName} profileValid={profileValid} onEmail={setEmail} onPassword={setPassword} onUsername={setUsername} onFirstName={setFirstName} onLastName={setLastName} onAuthenticate={authenticate} onClearStatus={()=>{setStatus('');setStatusIsAlert(false);}} /> : <div className="collaboration-grid"><section className="systems-card"><h2>{t('Tu cuenta y campaña', 'Your account and campaign')}</h2><p>{session.user.email}</p><p>{t('Estos datos serán públicos solo si publicas tu puntuación.', 'These details are public only if you publish your score.')}</p><label>{t('Usuario', 'Username')}<input maxLength={48} value={username} onChange={event=>setUsername(event.target.value)} /></label><label>{t('Primer nombre', 'First name')}<input maxLength={48} value={firstName} onChange={event=>setFirstName(event.target.value)} /></label><label>{t('Primer apellido', 'First surname')}<input maxLength={48} value={lastName} onChange={event=>setLastName(event.target.value)} /></label><button className="systems-secondary" disabled={busy || !profileValid} onClick={()=>void saveProfile()}>{t('GUARDAR PERFIL', 'SAVE PROFILE')}</button><button className="systems-secondary" onClick={()=>void cloudClient?.auth.signOut({scope:'local'})}>{t('CERRAR SESIÓN','SIGN OUT')}</button><p>{t('Elige cuándo guardar o recuperar tu progreso. La copia solo es accesible por tu cuenta; no incluye contraseñas ni preferencias de audio.', 'Choose when to save or restore your progress. Your backup is accessible only to your account; it excludes passwords and audio preferences.')}</p>{!cloudReady ? <p role="status">{t('Consultando copia…','Checking backup…')}</p> : <><p>{cloud ? `${t('Última copia', 'Last backup')}: ${new Date(cloud.updated_at).toLocaleString(language==='en'?'en-GB':'es-DO')}` : t('Aún no hay una copia en la nube.', 'There is no cloud backup yet.')}</p><div className="collaboration-actions"><button className="systems-secondary" onClick={()=>void saveCampaign()}>{t('GUARDAR AHORA','SAVE NOW')}</button>{cloud && <button className="systems-secondary" onClick={()=>{const snapshot=parseCampaignSnapshot(cloud.snapshot);if(!snapshot){setStatus(t('La copia no es válida.', 'The backup is invalid.'));return;}if(!window.confirm(t('¿Reemplazar los datos locales de campaña por esta copia? La página se recargará y tu sesión seguirá en esta pestaña.', 'Replace local campaign data with this backup? The page will reload and keep your session in this tab.')))return;try{restoreCampaign(window.localStorage,snapshot);window.location.reload();}catch{setStatus(t('No se pudo restaurar la copia local.', 'The local backup could not be restored.'));}}}>{t('RESTAURAR COPIA','RESTORE BACKUP')}</button>}</div><label className="auto-backup"><input type="checkbox" checked={autoSave} onChange={event=>setAutoSave(event.target.checked)} />{t('Guardar automáticamente los cambios de este dispositivo mientras esta pestaña esté abierta', 'Automatically save this device’s changes while this tab is open')}</label><small>{t('La primera copia automática puede reemplazar la copia remota; revísala antes. Los conflictos entre dispositivos detienen el guardado.', 'The first automatic save can replace the remote backup; review it first. Cross-device conflicts stop saving.')}</small></>}</section>
 <section className="systems-card"><h2>{t('Tus equipos', 'Your teams')}</h2><label>{t('Nuevo equipo', 'New team')}<input maxLength={60} value={teamName} onChange={event=>setTeamName(event.target.value)} /></label><button className="systems-secondary" disabled={busy || !teamName.trim()} onClick={()=>void createTeam()}>{t('CREAR EQUIPO','CREATE TEAM')}</button><label>{t('Código de invitación', 'Invitation code')}<input maxLength={32} autoComplete="off" value={joinCode} onChange={event=>setJoinCode(event.target.value.toLowerCase())} /></label><button className="systems-secondary" disabled={busy} onClick={()=>void joinTeam()}>{t('UNIRSE','JOIN TEAM')}</button>{invite && <div className="invite-box"><strong>{t('Comparte esta invitación de forma privada', 'Share this invitation privately')}</strong><input aria-label={t('Invitación generada','Generated invitation')} readOnly value={invite} /><small>{t('Cualquiera con el código puede intentar unirse; generar uno nuevo invalida el anterior.', 'Anyone with the code can try to join; generating a new one invalidates the previous code.')}</small></div>}
 {teams.length>0 && <><label>{t('Equipo activo','Active team')}<select value={teamId} onChange={event=>{setTeamId(event.target.value);setPlan(null);setTeamCampaign(null);setTeamCampaignReady(false);setInvite('');}}>{teams.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{team && <><p>{t('Participantes','Participants')}: {members.length}/4 · {t('Conectados','Online')}: {live.players.filter(player=>player.connected).length}/{members.length}</p><ul className="team-member-roster">{members.map(item=>{const player=live.players.find(entry=>entry.userId===item.user_id);const online=player?.connected===true;return <li key={item.user_id} className={online?'online':'offline'}><span className="team-member-indicator" aria-hidden="true"/><span className="team-member-name">{item.user_id===me?t('Tú','You'):player?.displayName??item.user_id.slice(0,8)} · {item.role}</span><strong>{online?t('CONECTADO','CONNECTED'):t('DESCONECTADO','DISCONNECTED')}</strong></li>;})}</ul><label>{t('Tu responsabilidad','Your responsibility')}<select value={myRole} onChange={event=>void updateRole(event.target.value)}><option value="planning">{t('Planificación','Planning')}</option><option value="engineering">{t('Ingeniería','Engineering')}</option><option value="science">{t('Ciencia','Science')}</option><option value="communications">{t('Comunicaciones','Communications')}</option></select></label><div className="collaboration-actions">{team.owner_id===me && <button className="systems-secondary" onClick={()=>void rotateInvite()}>{t('NUEVA INVITACIÓN','NEW INVITATION')}</button>}<button className="systems-secondary" onClick={()=>void exitTeam()}>{team.owner_id===me?t('ELIMINAR EQUIPO','DELETE TEAM'):t('SALIR DEL EQUIPO','LEAVE TEAM')}</button></div></>}</>}
 {team && <LiveTeamPanel language={language} me={me} live={live} />}{team && <div className="team-plan"><h3>{t('Plan compartido','Shared plan')}</h3><p>{t('La misión de referencia se comparte en tiempo real y los avatares del equipo se mueven en la escena 3D.', 'The shared mission is relayed in real time and team avatars move in the 3D scene.')}</p>{plan?.team_id === teamId && <p>{t('Misión','Mission')}: {plan.mission_id} · {t('revisión','revision')} {plan.revision}</p>}<div className="collaboration-actions"><button className="systems-secondary" disabled={!plan || plan.team_id!==teamId} onClick={()=>void publishPlan()}>{t('COMPARTIR DISEÑO GUARDADO','SHARE SAVED DESIGN')}</button><button className="systems-secondary" disabled={!parsedPlan} onClick={()=>{if(parsedPlan && !onApply(parsedPlan.missionId,parsedPlan.design))setStatus(t('Completa primero los capítulos necesarios para abrir esta misión.', 'Complete the required chapters before opening this mission.'));}}>{t('ABRIR PLAN','OPEN PLAN')}</button></div><small>{t('Se comparte el diseño guardado de la misión seleccionada actualmente.', 'Shares the saved design for your currently selected mission.')}</small><h3>{t('Campaña compartida', 'Shared campaign')}</h3><p>{t('Comparte tu progreso por turnos con los miembros del equipo. La copia contiene misiones, recursos e informes, no contraseñas.', 'Share your progress with team members in turns. The copy contains missions, resources and reports, not passwords.')}</p>{teamCampaign?.team_id === teamId && <p>{t('Revisión compartida', 'Shared revision')}: {teamCampaign.revision}</p>}<div className="collaboration-actions"><button className="systems-secondary" disabled={!teamCampaignReady || Boolean(teamCampaign && teamCampaign.team_id!==teamId)} onClick={()=>void shareTeamCampaign()}>{t('COMPARTIR CAMPAÑA', 'SHARE CAMPAIGN')}</button>{teamCampaign?.team_id === teamId && <button className="systems-secondary" onClick={()=>{const snapshot=parseCampaignSnapshot(teamCampaign.snapshot);if(!snapshot){setStatus(t('La copia del equipo no es válida.', 'The team backup is invalid.'));return;}if(!window.confirm(t('¿Reemplazar la campaña local con la del equipo? La página se recargará y tu sesión seguirá en esta pestaña.', 'Replace the local campaign with the team copy? The page will reload and keep your session in this tab.')))return;try{restoreCampaign(window.localStorage,snapshot);window.location.reload();}catch{setStatus(t('No se pudo restaurar la campaña.', 'The campaign could not be restored.'));}}}>{t('ABRIR CAMPAÑA DEL EQUIPO', 'OPEN TEAM CAMPAIGN')}</button>}</div></div>}</section></div>}
 {team && <MissionLaunchPanel language={language} me={me} live={live} members={members} mission={mission} isHost={live.hostId===me} onReady={setLiveReady} onStartMission={()=>{void startLiveMission(mission.id,{shipId,design}).then((started)=>{if(!started)setStatus(live.error||t('No se pudo iniciar: revisa la conexión, preparación del equipo y el plan compartido.','Could not start: check the connection, team readiness, and shared plan.'));});}} />}
 {status && <p role={statusIsAlert?'alert':'status'} aria-live={statusIsAlert?'assertive':'polite'} className="systems-warning">{status}</p>}
 </section>;
}


type AccountAuthPanelProps = {
 language: 'en' | 'es';
 busy: boolean;
 email: string;
 password: string;
 username: string;
 firstName: string;
 lastName: string;
 profileValid: boolean;
 onEmail: (value: string) => void;
 onPassword: (value: string) => void;
 onUsername: (value: string) => void;
 onFirstName: (value: string) => void;
 onLastName: (value: string) => void;
 onAuthenticate: (signUp: boolean) => void;
 onClearStatus: () => void;
};

function AccountAuthPanel({language,busy,email,password,username,firstName,lastName,profileValid,onEmail,onPassword,onUsername,onFirstName,onLastName,onAuthenticate,onClearStatus}: AccountAuthPanelProps) {
 const [registering,setRegistering]=useState(false);
 const t=(es:string,en:string)=>language==='es'?es:en;
 return <div className="systems-card account-card">
  <h2>{registering?t('Crear una cuenta','Create an account'):t('Iniciar sesión','Sign in')}</h2>
  <p>{registering?t('Regístrate con tu correo y crea un perfil para participar en equipos y el podio.','Register with your email and create a profile to join teams and the leaderboard.'):t('La sesión se conserva en esta pestaña aunque recargues; otros dispositivos requieren iniciar sesión.','Your session stays in this tab after a reload; other devices require a separate sign-in.')}</p>
  <form onSubmit={event=>{event.preventDefault();onAuthenticate(registering);}}>
   <label htmlFor="account-email">{t('Correo electrónico','Email address')}<input id="account-email" type="email" autoComplete="email" required maxLength={254} value={email} placeholder="nombre@dominio.com" aria-describedby={registering?'account-email-help':undefined} onChange={event=>{onClearStatus();onEmail(event.target.value);}} /></label>
   {registering&&<small id="account-email-help" className="auth-field-help">{t('Usa un correo válido al que puedas entrar; enviaremos allí el enlace de confirmación.','Use an email address you can access; we will send the confirmation link there.')}</small>}
   <label htmlFor="account-password">{t('Contraseña','Password')}<input id="account-password" type="password" autoComplete={registering?'new-password':'current-password'} required minLength={registering?12:1} maxLength={128} value={password} placeholder={registering?t('Mínimo 12 caracteres','At least 12 characters'):t('Tu contraseña','Your password')} aria-describedby={registering?'account-password-help':undefined} onChange={event=>{onClearStatus();onPassword(event.target.value);}} /></label>
   {registering&&<small id="account-password-help" className="auth-field-help">{t('Crea una contraseña nueva de 12 caracteres o más. No uses la contraseña de tu correo.','Create a new password with 12 or more characters. Do not reuse your email password.')}</small>}
   {registering&&<><label htmlFor="account-username">{t('Usuario','Username')}<input id="account-username" required maxLength={48} autoComplete="username" value={username} placeholder={t('Ejemplo: ExploradoraLuna','Example: MoonExplorer')} aria-describedby="account-username-help" onChange={event=>{onClearStatus();onUsername(event.target.value);}} /></label><small id="account-username-help" className="auth-field-help">{t('Es el alias que verán tus compañeros. Máximo 48 caracteres; no pongas información privada.','This is the name teammates will see. Up to 48 characters; do not use private information.')}</small><label htmlFor="account-first-name">{t('Nombre','First name')}<input id="account-first-name" required maxLength={48} autoComplete="given-name" value={firstName} placeholder={t('Ejemplo: Ana María','Example: Ana Maria')} aria-describedby="account-first-name-help" onChange={event=>{onClearStatus();onFirstName(event.target.value);}} /></label><small id="account-first-name-help" className="auth-field-help">{t('Tu nombre o nombre preferido. Se aceptan espacios y tildes.','Your first or preferred name. Spaces and accented letters are accepted.')}</small><label htmlFor="account-last-name">{t('Apellido','Surname')}<input id="account-last-name" required maxLength={48} autoComplete="family-name" value={lastName} placeholder={t('Ejemplo: García López','Example: Garcia Lopez')} aria-describedby="account-last-name-help" onChange={event=>{onClearStatus();onLastName(event.target.value);}} /></label><small id="account-last-name-help" className="auth-field-help">{t('Tu apellido; puedes incluir dos apellidos, espacios o guiones.','Your surname; you can include multiple names, spaces, or hyphens.')}</small></>}
   {registering&&<p className="auth-registration-hint">{t('Todos los campos son obligatorios. El usuario, nombre y apellido admiten de 1 a 48 caracteres.','All fields are required. Username, first name, and surname accept 1 to 48 characters.')}</p>}
   <div className="collaboration-actions"><button className="systems-primary" disabled={busy||(registering&&(!profileValid||password.length<12))}>{busy?t('PROCESANDO…','PROCESSING…'):registering?t('CREAR CUENTA','CREATE ACCOUNT'):t('INICIAR SESIÓN','SIGN IN')}</button></div>
  </form>
  <button type="button" className="systems-secondary" disabled={busy} onClick={()=>{setRegistering(value=>!value);onClearStatus();}}>{registering?t('Ya tengo cuenta · Iniciar sesión','Already registered · Sign in'):t('¿Nuevo por aquí? · Crear cuenta','New here? · Create account')}</button>
 </div>;
}

function LiveTeamPanel({ language, me, live }: { language: 'en' | 'es'; me?: string; live: LiveSnapshot }) {
 const [draft,setDraft]=useState(''); const [notice,setNotice]=useState(''); const previous=useRef<Set<string>|null>(null); const t=(es:string,en:string)=>language==='es'?es:en;
 useEffect(()=>{const current=new Set(live.players.filter(player=>player.connected).map(player=>player.userId));if(previous.current){const left=[...previous.current].filter(id=>!current.has(id));const joined=[...current].filter(id=>!previous.current?.has(id));if(left.length)setNotice(t(`${left.map(id=>live.players.find(player=>player.userId===id)?.displayName??id.slice(0,8)).join(', ')} se desconectó; la misión y su progreso siguen guardados.` ,`${left.map(id=>live.players.find(player=>player.userId===id)?.displayName??id.slice(0,8)).join(', ')} disconnected; mission and progress remain saved.`));else if(joined.length)setNotice(t(`${joined.length} integrante${joined.length===1?'':'s'} se conectó al equipo.`,`${joined.length} teammate${joined.length===1?'':'s'} joined the team.`));}previous.current=current;},[live.players,t]);
 return <section className="live-team-panel"><header><div><span className={live.connected?'live-team-dot':'live-team-dot offline'} /> <strong>COOPERATIVE MULTIPLAYER · {t('MISIÓN EN EQUIPO','TEAM MISSION')}</strong></div><small>{live.connected?t('EN LÍNEA','ONLINE'):t('DESCONECTADO','OFFLINE')} · {live.players.filter(player=>player.connected).length}/4</small></header>
  <p>{t('Presencia, poses y mensajes viajan por un canal privado. En la vista 3D, usa WASD o las flechas para moverte, Mayús para correr, E para abordar y F para interactuar.', 'Presence, poses and messages use a private channel. In the 3D view, use WASD or arrow keys to move, Shift to run, E to board and F to interact.')}</p>
  {notice&&<p role="status" className="systems-warning">{notice}</p>}<ul className="live-roster">{live.players.map(player=><li key={player.userId} className={player.connected?'':'offline'}><i className={`live-dot${player.connected?'':' offline'}`}/><span><b>{player.displayName}{player.userId===me?` (${t('tú','you')})`:''}</b><small>{player.role} {player.isHost?` · ${t('ANFITRIÓN','HOST')}`:''}</small></span><small>{!player.connected?t('DESCONECTADO','DISCONNECTED'):player.pose.activity==='aboard'?t('A BORDO','ABOARD'):t('CONECTADO','CONNECTED')}</small></li>)}</ul>
  {live.error&&<p role="status" className="systems-warning">{live.error}</p>}
  <div className="live-chat" role="log" aria-live="polite" aria-label={t('Mensajes del equipo','Team messages')}>{live.messages.map(message=><p key={message.id}><b>{message.displayName}</b><small> · {message.role}</small><br/>{message.text}</p>)}</div>
  <form className="live-chat-compose" onSubmit={event=>{event.preventDefault();if(sendLiveMessage(draft))setDraft('');}}><label className="visually-hidden" htmlFor="live-team-message">{t('Mensaje para el equipo','Message to team')}</label><input id="live-team-message" maxLength={240} value={draft} onChange={event=>setDraft(event.target.value)} placeholder={t('Mensaje breve…','Short message…')} /><button className="systems-secondary" disabled={!live.connected||!draft.trim()}>{t('ENVIAR','SEND')}</button></form>
 </section>;
}

function MissionLaunchPanel({ language, me, live, members, mission, isHost, onReady, onStartMission }: { language: 'en' | 'es'; me?: string; live: LiveSnapshot; members: Member[]; mission: Mission; isHost: boolean; onReady: (ready: boolean) => void; onStartMission: () => void }) {
 const t=(es:string,en:string)=>language==='es'?es:en;
 const byId=new Map(live.players.map(player=>[player.userId,player]));
 const roles=new Set(['planning','engineering','science','communications']);
 const onlineMembers=members.filter(member=>byId.get(member.user_id)?.connected===true);
 const enoughPlayers=onlineMembers.length>=2;
 const rolesAssigned=enoughPlayers&&onlineMembers.every(member=>roles.has(member.role));
 const allReady=enoughPlayers&&onlineMembers.every(member=>byId.get(member.user_id)?.ready===true);
 const canStart=isHost&&enoughPlayers&&rolesAssigned&&allReady&&Boolean(mission.id)&&live.authoritativeSession?.status!=='active';
 const self=me?byId.get(me):undefined;
 const roleName=(role:string)=>({planning:t('PLANIFICACIÓN','PLANNING'),engineering:t('INGENIERÍA','ENGINEERING'),science:t('CIENCIA','SCIENCE'),communications:t('COMUNICACIONES','COMMUNICATIONS')} as Record<string,string>)[role]??t('SIN ROL','NO ROLE');
 const goal=(role:string)=>({planning:t('Coordinar la ruta de exploración','Coordinate the exploration route'),engineering:t('Mantener operativos los sistemas y el rover','Keep spacecraft systems and rover operational'),science:t('Analizar el terreno y recolectar muestras','Survey terrain and collect samples'),communications:t('Transmitir los datos de misión','Transmit mission data')} as Record<string,string>)[role]??t('Asigna una responsabilidad','Assign a responsibility');
 return <section className="mission-launch-panel" aria-label={t('Preparación de misión cooperativa','Cooperative mission preparation')}>
  <header><div><span>COOPERATIVE MULTIPLAYER</span><h2>{t('Preparar misión cooperativa','Prepare cooperative mission')}</h2></div><strong>{t('MISIÓN','MISSION')}: {mission.name}</strong></header>
  <p>{t('Se necesitan al menos 2 integrantes conectados y preparados. Los miembros desconectados pueden unirse después.', 'At least 2 connected teammates must be ready. Disconnected members can join later.')}</p>
  {!live.connected&&<p role="status" className="systems-warning">{live.error||t('Conectando con la sesión del equipo…','Connecting to the team session…')}</p>}
  <ul>{members.map(member=>{const player=byId.get(member.user_id);const online=player?.connected===true;const label=!online?t('DESCONECTADO','DISCONNECTED'):player.ready?t('PREPARADO','READY'):t('NO PREPARADO','NOT READY');return <li key={member.user_id} className={!online?'offline':player?.ready?'ready':''}><span className="launch-avatar">{(player?.displayName??member.user_id.slice(0,2)).slice(0,2).toUpperCase()}</span><span className="launch-member"><b>{player?.displayName??member.user_id.slice(0,8)}{member.user_id===me?` · ${t('TÚ','YOU')}`:''}</b><small>{roleName(member.role)} · {goal(member.role)}</small></span><strong>{label}</strong></li>;})}</ul>
  <div className="launch-checks"><span className={enoughPlayers?'passed':''}>{t('Conectados','Connected')} {onlineMembers.length}/{members.length} · {t('mínimo 2','minimum 2')}</span><span className={rolesAssigned?'passed':''}>{t('Roles de participantes','Active player roles')}</span><span className={allReady?'passed':''}>{t('Participantes preparados','Active players ready')}</span></div>
  <div className="mission-launch-actions">{self&&<button className="systems-secondary" aria-pressed={self.ready} onClick={()=>onReady(!self.ready)}>{self.ready?t('CANCELAR PREPARACIÓN','CANCEL READY'):t('ESTOY PREPARADO','I’M READY')}</button>}<button className="systems-primary" disabled={!canStart} aria-disabled={!canStart} onClick={onStartMission}>{t('INICIAR MISIÓN','START MISSION')} →</button></div>
  {!isHost&&<small>{t('Solo el anfitrión puede iniciar.','Only the host can start the mission.')}</small>}
 </section>;
}

