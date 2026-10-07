import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const root=path.dirname(fileURLToPath(import.meta.url));
const repository=path.resolve(root,'../..');
const client=new Client({name:'starself-production-review',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',path.join(repository,'src/cli/index.ts'),'mcp','--project',root],stderr:'pipe'});
const parse=r=>r.structuredContent??JSON.parse(r.content.find(c=>c.type==='text').text);
const call=async(name,args={})=>{
  const r=await client.callTool({name:'tool_call',arguments:{name,arguments:args,media:false}});
  assert.ok(!r.isError,JSON.stringify(r.content));return parse(r);
};
try{
  await client.connect(transport);
  const catalog=await client.listTools();assert.equal(catalog.tools.length,10);
  const context=await call('project_context');const validation=await call('project_validate');assert.equal(validation.valid,true);
  const schema=await client.callTool({name:'tool_schema',arguments:{name:'frame_capture'}});
  const shot=await call('frame_capture',{sceneId:'invocation',frame:144,width:1920,height:1080,output:path.join(root,'exports/poster.png')});
  const invalid=await client.callTool({name:'tool_call',arguments:{name:'frame_capture',arguments:{width:0,frame:-1},media:false}});assert.equal(invalid.isError,true);
  assert.equal((await call('project_context')).revision,context.revision);
  const report={catalogTools:catalog.tools.length,catalogBytes:Buffer.byteLength(JSON.stringify(catalog)),schemaBytes:Buffer.byteLength(JSON.stringify(schema)),resultBytes:Buffer.byteLength(JSON.stringify(shot)),revision:context.revision,valid:validation.valid,negativeRequestRejected:true,readOnlyRevisionPreserved:true,poster:shot};
  await writeFile(path.join(root,'exports/mcp-review.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await client.close();}
