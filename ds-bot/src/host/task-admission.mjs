// Isolated v5 bridge. Host must supply actual authority, roster and team lease;
// this module is deliberately disabled by default.
const id=x=>typeof x==='string'&&x.length>0&&x.length<=256&&!/[\x00-\x1f]/.test(x)
export function createV5GuardedAdmission({store,enabled=false,noAgentsResolved=()=>false,isActive=()=>false,resolveTarget=()=>undefined,resolveAgent,authorize=()=>false,makeMessage,sessionGeneration=()=>undefined,activateTurn=()=>{}}={}) {
  if(!store||typeof resolveAgent!=='function'||typeof makeMessage!=='function')throw new Error('admission dependencies unavailable')
  let started=false,closed=false
  const active=()=>enabled===true&&started&&!closed&&isActive()===true
  const target=(action,task)=>{const x=resolveTarget(action,task);return x&&x.botId===action.actor&&id(x.botId)&&id(x.sessionId)?x:undefined}
  const verifyAdmission=(task,action,intent)=>{
    const x=target(action,task)
    return active()&&!!x&&!!intent&&id(intent.admissionId)&&id(intent.messageId)&&intent.payload?.id===intent.messageId&&x.botId===intent.targetBotId&&x.sessionId===intent.targetSessionId&&authorize(task,action,intent)===true
  }
  return {
    startBeforeRestore(){if(closed||started||enabled!==true||noAgentsResolved()!==true)throw new Error('admission startup unavailable');store.holdGuardedAfterRestart({actor:'host'});started=true},
    available:active,verifyAdmission,
    verifyReceipt(_action,state,receipt){return active()&&state==='uncertain'&&receipt==='admission outcome unknown'},
    coordinatorFor(agent){
      if(!agent||!id(agent.id)||agent.durableAdmissionVersion!==1)throw new Error('guarded Agent unavailable')
      return (sessionId,inputs,claim,position)=>{
        if(!active()||sessionId!==agent.id)throw new Error('guarded Agent changed')
        const generation=agent.guardedClaimTurnVersion===1 ? sessionGeneration(agent) : undefined
        const context=generation&&position ? {sessionGeneration:generation,turn:position.turn,turnStartSeq:position.turnStartSeq} : undefined
        const result=store.fencedGuardedClaim({sessionId,inputs,actor:'scheduler',context},claim)
        if(context)activateTurn(agent,position)
        return result
      }
    },
    async prepare(action,task){
      if(!active()||!id(action?.id)||authorize(task,action)!==true)return
      const x=target(action,task),message=makeMessage(action,task)
      if(!x||!message||!id(message.id)||message.role!=='user'||!Array.isArray(message.content)||!message.source?.kind)return
      return {admissionId:`board:${action.id}`,messageId:message.id,targetBotId:x.botId,targetSessionId:x.sessionId,payload:message}
    },
    async admit({action,task,intent,revalidate}){
      if(!active()||!verifyAdmission(task,action,intent)||await revalidate()!==true)throw new Error('admission unavailable')
      const x=target(action,task),agent=await resolveAgent(x.sessionId)
      if(!active()||await revalidate()!==true||!verifyAdmission(task,action,intent)||!agent||agent.id!==x.sessionId||agent.durableAdmissionVersion!==1||typeof agent.guardedSend!=='function')throw new Error('admission target changed')
      await agent.guardedSend(intent.payload,'next-turn',intent.admissionId)
      if(!active())throw new Error('admission ended with unknown outcome')
      return {state:'queued'}
    },
    close(){closed=true},
  }
}
