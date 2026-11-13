import {test} from 'node:test'
import assert from 'node:assert/strict'
import {install} from '../src/host/channel.js'
test('actual channel phoneServe wrapper refuses every legacy review endpoint before dispatch',async()=>{
 let handler,calls=0
 const rt={ctx:{effect(){},get(){}},state:{bots:{},rooms:{},mainBotIds:[]},phoneServe(fn){handler=fn},refresh:async()=>{},readOnly:()=>undefined,legacyReviewCall(){calls++;throw Error('must not execute')},noteFailure(){}}
 install(rt)
 for(const endpoint of ['legacy-review-list','legacy-review-get','legacy-review-create','legacy-review-finding']){const answer=await handler(endpoint,{workId:'w'});assert.equal(answer.ok,false);assert.equal(answer.error.code,'bot/refused')}
 assert.equal(calls,0)
 const other=await handler('nonexistent',{});assert.equal(other.ok,false);assert.equal(other.error.code,'bot/not-found')
})
