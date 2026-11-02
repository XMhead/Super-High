import JSZip from 'jszip'
import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// A reproducible OOXML deck: stable object IDs make animation checks independent of screenshots.
const NS = { p: 'http://schemas.openxmlformats.org/presentationml/2006/main', a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships', c: 'http://schemas.openxmlformats.org/drawingml/2006/chart' }
const C = { ink: '172554', blue: '2563EB', green: '16A34A', orange: 'EA580C', purple: '9333EA', pale: 'EFF6FF' }
const emu = value => Math.round(value * 9525)
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const rels = entries => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${NS.r}/${type}" Target="${target}"/>`).join('')}</Relationships>`
const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>'
const transform = (x, y, w, h) => `<a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(w)}" cy="${emu(h)}"/></a:xfrm>`
function text(id, x, y, w, h, value, options = {}) {
  const { size = 26, color = C.ink, fill, bold = false } = options
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escape(value)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${transform(x,y,w,h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : '<a:noFill/>'}<a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr lIns="${emu(12)}" rIns="${emu(12)}" tIns="${emu(9)}" bIns="${emu(9)}" anchor="ctr"/><a:lstStyle/>${String(value).split('\n').map(line=>`<a:p><a:r><a:rPr lang="zh-CN" sz="${size*100}" b="${bold?1:0}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Microsoft YaHei"/><a:ea typeface="Microsoft YaHei"/></a:rPr><a:t>${escape(line)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`
}
let timingId = 10
function effect(target, kind, { trigger = 'clickEffect', mode = 'entr', duration = 800, delay = 0, reverse = false } = {}) {
  const rootId = timingId++
  const behaviorId = timingId++
  const preset = { appear: 1, fade: 10, fly: 2, wipe: 22, zoom: 23, spin: 8, motion: 0 }[kind]
  const behavior = `<p:cBhvr><p:cTn id="${behaviorId}" dur="${kind==='appear'?1:duration}" fill="hold"/><p:tgtEl><p:spTgt spid="${target}"/></p:tgtEl></p:cBhvr>`
  const action = kind === 'spin' ? `<p:animRot by="21600000">${behavior}</p:animRot>`
    : kind === 'zoom' ? `<p:animScale>${behavior}<p:by x="150000" y="150000"/></p:animScale>`
      : kind === 'motion' ? `<p:animMotion origin="layout" path="M 0 0 L .06 -.08 C .08 -.12 .11 .08 .15 0 E" pathEditMode="relative">${behavior}</p:animMotion>`
        : kind === 'fly' ? `<p:anim calcmode="lin" valueType="num">${behavior.replace('</p:cBhvr>','<p:attrNameLst><p:attrName>ppt_x</p:attrName></p:attrNameLst></p:cBhvr>')}<p:tavLst><p:tav tm="0"><p:val><p:strVal val="#ppt_x-1"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#ppt_x"/></p:val></p:tav></p:tavLst></p:anim>`
          : kind === 'appear' ? `<p:set>${behavior}<p:to><p:strVal val="visible"/></p:to></p:set>`
            : `<p:animEffect transition="${mode==='exit'?'out':'in'}" filter="${kind==='wipe'?'wipe(right)':'fade'}">${behavior}</p:animEffect>`
  return { trigger, xml: `<p:par><p:cTn id="${rootId}" presetID="${preset}" presetClass="${mode}" presetSubtype="8" fill="hold" nodeType="${trigger}"${reverse?' autoRev="1"':''}><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst><p:childTnLst>${action}</p:childTnLst></p:cTn></p:par>` }
}
function timing(actions) {
  const groups = []
  for (const action of actions) {
    if (action.trigger === 'clickEffect' || !groups.length) groups.push([])
    groups.at(-1).push(action.xml)
  }
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${groups.map(items=>`<p:par><p:cTn id="${timingId++}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>${items.join('')}</p:childTnLst></p:cTn></p:par>`).join('')}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>`
}
const frame = (title, instruction, body) => text(2,44,26,872,72,title,{size:32,bold:true}) + text(3,44,102,872,76,instruction,{size:17}) + body
function image() {
  // Small deterministic PNG, no network or image-generation service required for this fixture.
  const width=160, height=90, pixels=Buffer.alloc((width*3+1)*height)
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
    const offset=y*(width*3+1)+1+x*3
    pixels[offset]=Math.round(x/width*240);pixels[offset+1]=Math.round(y/height*200);pixels[offset+2]=170
  }
  const crc=buffer=>{let value=0xffffffff;for(const byte of buffer){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^(value&1?0xedb88320:0)}return(value^0xffffffff)>>>0}
  const chunk=(name,data)=>{const type=Buffer.from(name),size=Buffer.alloc(4),sum=Buffer.alloc(4);size.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([size,type,data,sum])}
  const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))])
}

export async function createPresentationPreviewDemo() {
  timingId=10
  const slides=[]
  const add=(title,instruction,body,actions=[],transition='')=>slides.push({ title, instruction, body:frame(title,instruction,body), actions, transition })
  add('SuperHigh 预览与动画验收','检查中文、图片、图表与动画；点击“下一步”或按空格逐步播放。',
    text(4,56,210,848,110,'这份文件由源码脚本生成\n无需 Office、WPS 或 LibreOffice',{size:30}) + text(5,56,390,848,68,'每页顶部说明预期行为；关闭“动画”应显示全部静态内容。',{size:18}))
  add('01 · 四种点击入场','预期：每次点击分别出现一个对象，顺序为淡入、飞入、擦除、缩放。',
    [C.blue,C.green,C.orange,C.purple].map((fill,i)=>text(i+4,56+i*224,242,184,112,['淡入','左侧飞入','向右擦除','缩放入场'][i],{fill,color:'FFFFFF',size:22})).join(''),
    ['fade','fly','wipe','zoom'].map((kind,i)=>effect(i+4,kind)))
  add('02 · 同时与之后','预期：只点一次。蓝色先淡入，绿色延迟 0.15 秒同时开始，橙色随后出现。',
    [C.blue,C.green,C.orange].map((fill,i)=>text(i+4,56+i*300,242,248,112,['首先','与上一动画同时','上一动画之后'][i],{fill,color:'FFFFFF',size:20})).join(''),
    [effect(4,'fade',{duration:1500}),effect(5,'zoom',{trigger:'withEffect',delay:150,duration:1500}),effect(6,'fly',{trigger:'afterEffect',delay:300,duration:1000})])
  add('03 · 强调与运动路径','预期：依次旋转一周、放大后回到原尺寸、沿路径移动。可在过程中暂停。',
    text(4,70,235,205,75,'旋转 360°',{fill:C.blue,color:'FFFFFF',size:22}) + text(5,355,235,205,75,'缩放并还原',{fill:C.green,color:'FFFFFF',size:22})
      + text(6,620,235,150,75,'路径移动',{fill:C.orange,color:'FFFFFF',size:20}),
    [effect(4,'spin',{mode:'emph',duration:1800}),effect(5,'zoom',{mode:'emph',duration:900,reverse:true}),effect(6,'motion',{mode:'path',duration:1800})])
  add('04 · 三种退场','预期：三个对象最初可见；点击后依次淡出、缩小、擦除。重播应还原。',
    [C.blue,C.green,C.orange].map((fill,i)=>text(i+4,56+i*300,242,248,112,['淡出','缩小退场','擦除退场'][i],{fill,color:'FFFFFF',size:22})).join(''),
    ['fade','zoom','wipe'].map((kind,i)=>effect(i+4,kind,{mode:'exit'})))
  const picture=`<p:pic><p:nvPicPr><p:cNvPr id="4" name="内嵌渐变图片"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="image"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${transform(56,205,320,180)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  const chart=`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="柱状图"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(430)}" y="${emu(185)}"/><a:ext cx="${emu(450)}" cy="${emu(280)}"/></p:xfrm><a:graphic><a:graphicData uri="${NS.c}"><c:chart xmlns:c="${NS.c}" r:id="chart"/></a:graphicData></a:graphic></p:graphicFrame>`
  add('05 · 图片与原生图表','预期：第一次点击显示渐变图片，第二次显示 20 / 40 / 30 的柱状图。',picture+chart,
    [effect(4,'fade'),effect(5,'fade')])
  for(const [index,name,type,bg] of [[6,'淡化','fade',C.pale],[7,'推入','push', 'ECFDF5'],[8,'擦除','wipe','FFF7ED']]) {
    add(`${String(index).padStart(2,'0')} · 页间${name}`,`预期：进入此页时播放${name}切换；翻页、缩放后正文应保持完整。`,
      text(4,80,220,800,130,index===8?'验收完成\n可返回任意页面重播':'中文 / English / 12345',{size:38,bold:true}),[],
      `<p:transition spd="slow"><p:${type}${type==='fade'?'':' dir="r"'}/></p:transition>`)
    slides.at(-1).background=bg
  }
  const zip=new JSZip()
  zip.file('[Content_Types].xml',`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slides.map((_,i)=>`<Override PartName="/ppt/slides/slide${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`)
  zip.file('_rels/.rels',rels([['document','officeDocument','ppt/presentation.xml']]))
  zip.file('ppt/presentation.xml',`<?xml version="1.0"?><p:presentation xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="master"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_,i)=>`<p:sldId id="${256+i}" r:id="slide${i+1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${emu(960)}" cy="${emu(540)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`)
  zip.file('ppt/_rels/presentation.xml.rels',rels([['master','slideMaster','slideMasters/slideMaster1.xml'],...slides.map((_,i)=>[`slide${i+1}`,'slide',`slides/slide${i+1}.xml`])]))
  zip.file('ppt/slideMasters/slideMaster1.xml',`<?xml version="1.0"?><p:sldMaster xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="layout"/></p:sldLayoutIdLst></p:sldMaster>`)
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels',rels([['layout','slideLayout','../slideLayouts/slideLayout1.xml']]))
  zip.file('ppt/slideLayouts/slideLayout1.xml',`<?xml version="1.0"?><p:sldLayout xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}" type="blank"><p:cSld><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels',rels([['master','slideMaster','../slideMasters/slideMaster1.xml']]))
  slides.forEach((slide,i)=>{
    zip.file(`ppt/slides/slide${i+1}.xml`,`<?xml version="1.0"?><p:sld xmlns:p="${NS.p}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${slide.background??'FFFFFF'}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${group}${slide.body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${slide.transition}${slide.actions.length?timing(slide.actions):''}</p:sld>`)
    zip.file(`ppt/slides/_rels/slide${i+1}.xml.rels`,rels([['layout','slideLayout','../slideLayouts/slideLayout1.xml'],...(i===5?[['image','image','../media/preview.png'],['chart','chart','../charts/chart1.xml']]:[])]))
  })
  zip.file('ppt/media/preview.png',image())
  zip.file('ppt/charts/chart1.xml',`<?xml version="1.0"?><c:chartSpace xmlns:c="${NS.c}" xmlns:a="${NS.a}" xmlns:r="${NS.r}"><c:chart><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>预览数据</c:v></c:tx><c:spPr><a:solidFill><a:srgbClr val="2563EB"/></a:solidFill></c:spPr><c:cat><c:strLit><c:ptCount val="3"/>${['A','B','C'].map((v,i)=>`<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:strLit></c:cat><c:val><c:numLit><c:formatCode>0</c:formatCode><c:ptCount val="3"/>${[20,40,30].map((v,i)=>`<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:numLit></c:val></c:ser><c:gapWidth val="100"/><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="b"/><c:crossAx val="2"/><c:crosses val="autoZero"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="1"/><c:crosses val="autoZero"/></c:valAx></c:plotArea><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`)
  // Fix entry timestamps so regenerating the deck produces identical bytes.
  zip.forEach((_path,entry)=>{entry.date=new Date('2026-10-25T00:00:00Z')})
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'})
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const output=resolve(process.argv[2]??'examples/PowerPoint预览与动画验收.pptx')
  await mkdir(dirname(output),{recursive:true})
  const bytes=await createPresentationPreviewDemo()
  await writeFile(output,bytes)
  console.log(`Created 9-slide preview and animation demo: ${output} (${bytes.length} bytes)`)
}
