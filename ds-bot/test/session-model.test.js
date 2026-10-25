import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionComplete } from '../src/host/browser/session-model.js'

const header = {
  config: { provider: 'mock-provider', model: 'session-model', temperature: 0.25 },
  tools: [{ name: 'session-private-tool', description: 'not for browser_task', parameters: {} }],
}

function fixture(chunks, { attachments, inputModalities } = {}) {
  const requests = []
  const tags = []
  const ctx = {
    get: name => name === 'attachments' ? attachments : undefined,
    llm: {
      async *stream(request) {
        requests.push(request)
        yield* chunks
      },
      async resolveModelInfo() {
        return { inputModalities }
      },
    },
  }
  const session = {
    id: 'session-browser-task',
    requestHeader: () => header,
  }
  const rt = {
    tagUsage(messages, options) {
      tags.push(options)
      return messages
    },
  }
  return { ctx, exec: { agent: { session }, signal: new AbortController().signal }, rt, requests, tags }
}

const stop = { type: 'finish', reason: { kind: 'stop' } }

test('session completion converts DSH text to an OpenAI chat response', async () => {
  const setup = fixture([
    { type: 'text-delta', index: 0, text: 'The page title is Example.' },
    stop,
  ])
  const complete = sessionComplete(setup.ctx, setup.exec, setup.rt)
  const result = await complete({
    messages: [{ role: 'system', content: 'Use the browser.' }, { role: 'user', content: 'Read the title.' }],
    tools: [],
  })

  assert.equal(result.choices[0].message.content, 'The page title is Example.')
  assert.deepEqual(setup.tags, [{ sessionId: 'session-browser-task', kind: 'browser-task' }])
})

test('session completion preserves DSH tool-call identity, name, and JSON arguments', async () => {
  const setup = fixture([
    { type: 'tool-call-delta', index: 0, id: 'call-browser-1', name: 'browser_open', argumentsDelta: '{"url":"https://example.com"}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const result = await sessionComplete(setup.ctx, setup.exec, setup.rt)({
    messages: [{ role: 'user', content: 'Open example.com.' }],
    tools: [],
  })

  assert.deepEqual(result.choices[0].message.tool_calls, [{
    id: 'call-browser-1',
    type: 'function',
    function: { name: 'browser_open', arguments: '{"url":"https://example.com"}' },
  }])
})

test('follow-up assistant tool call and tool result are converted to DSH messages', async () => {
  const setup = fixture([
    { type: 'text-delta', index: 0, text: 'Done.' },
    stop,
  ])
  const messages = [
    { role: 'system', content: 'Use browser tools.' },
    { role: 'user', content: 'Open the page.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call-browser-2',
        type: 'function',
        function: { name: 'browser_open', arguments: '{"url":"https://example.com"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-browser-2', content: 'Opened https://example.com' },
  ]
  const result = await sessionComplete(setup.ctx, setup.exec, setup.rt)({
    messages,
    tools: [{
      type: 'function',
      function: { name: 'browser_snapshot', description: 'Read page', parameters: { type: 'object' } },
    }],
  })

  assert.equal(result.choices[0].message.content, 'Done.')
  const request = setup.requests[0]
  assert.deepEqual(request.messages.map(message => message.role), ['system', 'user', 'assistant', 'tool'])
  assert.deepEqual(request.messages[2].content, [{
    type: 'tool-call',
    id: 'call-browser-2',
    name: 'browser_open',
    arguments: '{"url":"https://example.com"}',
  }])
  assert.equal(request.messages[3].toolCallId, 'call-browser-2')
  assert.deepEqual(request.messages[3].content, [{ type: 'text', text: 'Opened https://example.com' }])
  assert.deepEqual(request.tools, [{
    name: 'browser_snapshot',
    description: 'Read page',
    parameters: { type: 'object' },
  }])
  assert.equal(request.model, 'session-model')
  assert.equal(request.provider, 'mock-provider')
  assert.equal(request.sessionId, 'session-browser-task')
  assert.deepEqual(setup.tags, [{ sessionId: 'session-browser-task', kind: 'browser-task' }])
})

test('browser screenshots become DSH image blocks when the attachment store is available', async () => {
  const saved = []
  const attachments = {
    async saveImages(inputs) {
      saved.push(...inputs)
      return [{
        attachmentId: 'sha256:image',
        mediaType: 'image/jpeg',
        bytes: inputs[0].data.length,
        width: 1,
        height: 1,
      }]
    },
  }
  const setup = fixture([stop], { attachments, inputModalities: ['text', 'image'] })
  await sessionComplete(setup.ctx, setup.exec)({
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Screenshot.' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AA=' } },
      ],
    }],
    tools: [],
  })

  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/jpeg')
  assert.deepEqual(setup.requests[0].messages[0].content[1], {
    type: 'image',
    attachment: {
      attachmentId: 'sha256:image',
      mediaType: 'image/jpeg',
      bytes: saved[0].data.length,
      width: 1,
      height: 1,
    },
  })
})

test('missing Bot session model fails with a clear error', async () => {
  const setup = fixture([stop])
  const complete = sessionComplete(setup.ctx, { agent: { session: {} } })
  await assert.rejects(
    complete({ messages: [], tools: [] }),
    { message: 'browser_task needs a Bot session model' },
  )
})
