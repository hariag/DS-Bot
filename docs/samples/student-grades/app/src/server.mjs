import http from 'node:http'
import { gpa } from './grades.mjs'
const server = http.createServer((request, response) => {
  if (request.url === '/health') { response.writeHead(200); response.end('ok'); return }
  if (request.url?.startsWith('/gpa')) { response.writeHead(200, {'content-type':'application/json'}); response.end(JSON.stringify({ gpa:gpa([90, 80, 70, 60]) })); return }
  response.writeHead(404); response.end('not found')
})
server.listen(0, '127.0.0.1', () => console.log('PORT:' + server.address().port))
