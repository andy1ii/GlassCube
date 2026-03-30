let previewImg, exportImg, img, originalLoadedImg; 
let dimShader;
let fileInput, aspectRatioSelect, bandFreqSlider;
let blurAmountSlider, frostAmountSlider, blurAngleSlider, spreadSlider, turbulenceSlider;
let statusText, monotoneBtn;

let currentExportW = 1920, currentExportH = 1080;
let isMonotone = false;

// --- HELPER GLSL FUNCTIONS ---
const glslHelpers = `
float random(vec2 st) { return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123); }

float noise (in vec2 st) {
    vec2 i = floor(st);
    vec2 f = fract(st);
    float a = random(i);
    float b = random(i + vec2(1.0, 0.0));
    float c = random(i + vec2(0.0, 1.0));
    float d = random(i + vec2(1.0, 1.0));
    vec2 u = f*f*(3.0-2.0*f);
    return mix(a, b, u.x) + (c - a)* u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

float fbm (in vec2 st) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
        value += amplitude * noise(st);
        st *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}
`;

// --- SHADER: CLEAN SINGLE CUBE CORNER (SIMPLIFIED OPTICS) ---
const dimFragShader = `
precision mediump float;
varying vec2 vTexCoord;
uniform sampler2D tex0;
uniform vec2 resolution;

uniform float amount;       
uniform float frost;
uniform float spread;       
uniform float turbulence;   
uniform float bandFrequency;
uniform float angle;        

uniform float patchAmount;
uniform float maskHardness;
uniform float time;
uniform float u_monotone;

${glslHelpers}

void main() {
    vec2 uv = vTexCoord;
    uv.y = 1.0 - uv.y; 
    vec4 originalPixel = texture2D(tex0, uv);

    // --- 1. SINGLE CUBE CORNER MAPPING ---
    vec2 toPixel = uv - vec2(0.5);
    toPixel.x *= resolution.x / resolution.y; 
    
    float PI = 3.14159265359;
    float a = atan(toPixel.y, toPixel.x);
    if (a < 0.0) a += 2.0 * PI;

    float faceId;
    vec2 planeUV;
    vec2 baseReflectUV;
    vec2 internalReflectUV;
    vec2 faceNormal;

    float cos30 = 0.8660254; 
    float sin30 = 0.5;

    // The Y-shaped intersection creates 3 distinct giant walls
    if (a >= PI / 2.0 && a < 7.0 * PI / 6.0) {
        faceId = 1.0; // Left Wall
        planeUV = vec2(-toPixel.x / cos30, toPixel.y + (-toPixel.x / cos30) * sin30);
        baseReflectUV = vec2(1.0 - uv.x, uv.y) + vec2(0.1, -0.05);
        internalReflectUV = vec2(1.0 - uv.x, uv.y);
        faceNormal = vec2(0.4, -0.2); // Bends light to the right
    } 
    else if (a >= 7.0 * PI / 6.0 && a < 11.0 * PI / 6.0) {
        faceId = 2.0; // Floor
        float px = toPixel.x / cos30;
        float py = -toPixel.y / sin30;
        planeUV = vec2((px + py) * 0.5, (-px + py) * 0.5);
        baseReflectUV = vec2(uv.x, 1.0 - uv.y) - vec2(0.0, 0.1);
        internalReflectUV = vec2(uv.x, 1.0 - uv.y);
        faceNormal = vec2(0.0, -0.4); // Bends light up
    } 
    else {
        faceId = 3.0; // Right Wall
        planeUV = vec2(toPixel.x / cos30, toPixel.y + (toPixel.x / cos30) * sin30);
        baseReflectUV = vec2(1.0 - uv.x, uv.y) - vec2(0.1, 0.05);
        internalReflectUV = vec2(1.0 - uv.x, uv.y);
        faceNormal = vec2(-0.4, -0.2); // Bends light to the left
    }

    // --- 2. OPTIONAL INNER SUBDIVISIONS ---
    float scale = max(1.0, floor(bandFrequency * 0.5)); 
    vec2 gridUV = planeUV * scale;
    vec2 gridFract = fract(gridUV);
    
    // Subtle bevel on the optional inner subdivisions
    vec2 cellDeriv = (gridFract - vec2(0.5)) * 2.0; 
    vec2 cellBevel = sign(cellDeriv) * pow(abs(cellDeriv), vec2(4.0)); 
    
    // Combine base face normal with tiny micro bevels
    vec2 ridgeNormal = faceNormal + (cellBevel * 0.1 * turbulence);
    vec2 refractionDistortion = ridgeNormal * (spread * 0.05);

    // --- 3. SEAM DISTANCES ---
    float a_deg = degrees(a);
    float dist1 = abs(a_deg - 90.0);
    float dist2 = abs(a_deg - 210.0);
    float dist3 = abs(a_deg - 330.0);
    if (dist3 > 180.0) dist3 = 360.0 - dist3; 
    float minDistAngle = min(min(dist1, dist2), dist3);
    float mainSeamDist = length(toPixel) * sin(radians(minDistAngle));

    float gridBorderX = min(gridFract.x, 1.0 - gridFract.x);
    float gridBorderY = min(gridFract.y, 1.0 - gridFract.y);
    float innerSeamDist = min(gridBorderX, gridBorderY) / scale;

    // --- 4. SPECULAR HIGHLIGHTS ---
    vec3 lightVector = normalize(vec3(0.5, 0.5, 1.0)); 
    vec3 surfaceNormal3D = normalize(vec3(ridgeNormal.x, ridgeNormal.y, 1.5));
    float gloss = turbulence * 0.5;
    float specDot = max(0.0, dot(surfaceNormal3D, lightVector));
    float specHighlight = pow(specDot, 20.0) * gloss;

    // --- 5. REFRACTION & BLUR SAMPLING ---
    float rotRad = radians(angle);
    mat2 rotMat = mat2(cos(rotRad), -sin(rotRad), sin(rotRad), cos(rotRad));
    baseReflectUV = (baseReflectUV - vec2(0.5)) * rotMat + vec2(0.5);
    internalReflectUV = (internalReflectUV - vec2(0.5)) * rotMat + vec2(0.5);

    vec3 finalGlassColor = vec3(0.0);
    float totalWeight = 0.0;
    
    float iters = clamp(amount, 10.0, 60.0);
    float reflMix = (faceId == 2.0) ? 0.65 : 0.45; 
    
    // The blur radius is tied to the 'amount' uniform (Blur Intensity slider)
    float blurRadius = pow(clamp((amount - 1.0) / 59.0, 0.0, 1.0), 1.2); 

    for (int i = 0; i < 60; i++) {
        if (float(i) >= iters) break;
        float f = float(i) / iters;
        
        vec2 depthBlur = vec2(f * 0.005); 
        
        // Random jitter for the multi-sample blur, scaling with blurRadius
        float jitterX = (random(uv + vec2(float(i), 0.0)) - 0.5) * 0.08 * blurRadius;
        float jitterY = (random(uv + vec2(0.0, float(i))) - 0.5) * 0.08 * blurRadius;
        vec2 blurScatter = vec2(jitterX, jitterY);

        vec2 sampleEnvUV = baseReflectUV + refractionDistortion + depthBlur + blurScatter;
        vec2 sampleReflUV = internalReflectUV + (refractionDistortion * 1.5) + depthBlur + blurScatter;

        sampleEnvUV = abs(mod(sampleEnvUV - vec2(1.0), 2.0) - vec2(1.0));
        sampleReflUV = abs(mod(sampleReflUV - vec2(1.0), 2.0) - vec2(1.0));

        vec3 envSample = texture2D(tex0, sampleEnvUV).rgb;
        vec3 reflSample = texture2D(tex0, sampleReflUV).rgb;

        vec3 blended = mix(envSample, reflSample, reflMix);
        float weight = exp(-f * 2.0);
        finalGlassColor += blended * weight;
        totalWeight += weight;
    }

    finalGlassColor /= totalWeight;
    finalGlassColor += vec3(specHighlight);

    // --- 6. VERY SUBTLE SEAMS & STRUCTURE ---
    if (faceId == 1.0) finalGlassColor *= 1.15;      
    else if (faceId == 2.0) finalGlassColor *= 0.90; 
    else if (faceId == 3.0) finalGlassColor *= 1.05; 

    finalGlassColor += vec3(0.05); 
    
    vec3 glassCube = finalGlassColor;
    float lineThickness = mix(0.01, 0.002, maskHardness);
    
    float innerGlint = smoothstep(lineThickness, 0.0, innerSeamDist);
    glassCube += pow(innerGlint, 2.0) * 0.05 * vec3(1.0); 
    glassCube *= mix(1.0, 0.95, innerGlint); 

    float mainGlint = smoothstep(lineThickness * 1.5, 0.0, mainSeamDist);
    glassCube += pow(mainGlint, 2.0) * 0.1 * vec3(1.0); 
    glassCube *= mix(1.0, 0.85, mainGlint); 

    // --- 7. OUTER PORTAL MASK ---
    float mask = 1.0; 

    vec3 outColor = mix(originalPixel.rgb, glassCube, mask);
    
    // Static film grain is now correctly tied to the 'frost' uniform
    float globalGrain = (random(uv + time) - 0.5) * (0.25 * frost);
    outColor += vec3(globalGrain);
    outColor = (outColor - 0.5) * 1.15 + 0.5;

    // --- 8. BLACK AND WHITE TOGGLE ---
    float gray = dot(outColor, vec3(0.299, 0.587, 0.114));
    outColor = mix(outColor, vec3(gray), u_monotone);

    gl_FragColor = vec4(outColor, 1.0);
}
`;

const vertShader = `
attribute vec3 aPosition;
attribute vec2 aTexCoord;
varying vec2 vTexCoord;
void main() {
  vTexCoord = aTexCoord;
  vec4 positionVec4 = vec4(aPosition, 1.0);
  positionVec4.xy = positionVec4.xy * 2.0 - 1.0;
  gl_Position = positionVec4;
}
`;

function cropToRatio(sourceImg, targetW, targetH) {
  let sourceAspect = sourceImg.width / sourceImg.height;
  let targetAspect = targetW / targetH;
  let cropW, cropH, cropX, cropY;

  if (sourceAspect > targetAspect) {
    cropH = sourceImg.height;
    cropW = sourceImg.height * targetAspect;
    cropX = (sourceImg.width - cropW) / 2;
    cropY = 0;
  } else {
    cropW = sourceImg.width;
    cropH = sourceImg.width / targetAspect;
    cropX = 0;
    cropY = (sourceImg.height - cropH) / 2;
  }

  let cropped = sourceImg.get(cropX, cropY, cropW, cropH);
  cropped.resize(targetW, targetH);
  return cropped;
}

function setup() {
  let canvas = createCanvas(960, 540, WEBGL);
  canvas.parent('canvas-container');
  pixelDensity(1);

  dimShader = createShader(vertShader, dimFragShader);

  fileInput = select('#file-input');
  fileInput.elt.addEventListener('change', handleFile);
  
  aspectRatioSelect = select('#aspect-ratio');
  aspectRatioSelect.changed(updateAspectRatio);

  bandFreqSlider = select('#band-frequency');
  blurAmountSlider = select('#blur-amount');
  frostAmountSlider = select('#frost-amount');
  spreadSlider = select('#spread-amount');
  turbulenceSlider = select('#turbulence-amount');
  blurAngleSlider = select('#blur-angle');
  
  monotoneBtn = select('#monotone-btn');
  monotoneBtn.mousePressed(() => {
    isMonotone = !isMonotone;
    if(isMonotone) {
      monotoneBtn.html('Revert to Color');
      monotoneBtn.style('background-color', '#666');
    } else {
      monotoneBtn.html('Toggle B&W');
      monotoneBtn.style('background-color', '');
    }
  });

  select('#download-btn').mousePressed(downloadProcessedImage);
  
  statusText = select('#status');
  background(20);
}

function handleFile(event) {
  const file = event.target.files[0];
  if (file) {
    statusText.html("Processing image...");
    loadImage(URL.createObjectURL(file), loadedImg => {
      originalLoadedImg = loadedImg; 
      processImageForRatio();
    });
  }
}

function updateAspectRatio() {
  if (originalLoadedImg) {
    processImageForRatio();
  }
}

function processImageForRatio() {
  let ratio = aspectRatioSelect.value();
  let previewW, previewH;

  switch(ratio) {
    case "16:9": currentExportW = 1920; currentExportH = 1080; previewW = 960; previewH = 540; break;
    case "21:9": currentExportW = 2560; currentExportH = 1080; previewW = 1280; previewH = 540; break;
    case "9:16": currentExportW = 1080; currentExportH = 1920; previewW = 540; previewH = 960; break;
    case "3:4":  currentExportW = 1080; currentExportH = 1440; previewW = 540; previewH = 720; break;
    case "4:5":  currentExportW = 1080; currentExportH = 1350; previewW = 540; previewH = 675; break;
    case "1:1":  currentExportW = 1080; currentExportH = 1080; previewW = 540; previewH = 540; break;
    case "4:3":  currentExportW = 1440; currentExportH = 1080; previewW = 720; previewH = 540; break;
  }

  statusText.html(`Formatting for ${currentExportW}x${currentExportH}...`);
  exportImg = cropToRatio(originalLoadedImg, currentExportW, currentExportH);
  previewImg = cropToRatio(originalLoadedImg, previewW, previewH);
  img = previewImg;
  resizeCanvas(img.width, img.height);
  statusText.html(`Ready!<br><br>Aspect Ratio locked to ${ratio}.`);
}

function draw() {
  if (!img) return;

  shader(dimShader);
  dimShader.setUniform('tex0', img);
  dimShader.setUniform('resolution', [width, height]);
  
  dimShader.setUniform('bandFrequency', parseFloat(bandFreqSlider.value()));
  dimShader.setUniform('patchAmount', 1.0);    
  dimShader.setUniform('maskHardness', 1.0);   
  dimShader.setUniform('amount', parseFloat(blurAmountSlider.value()));
  dimShader.setUniform('frost', parseFloat(frostAmountSlider.value()));
  dimShader.setUniform('angle', parseFloat(blurAngleSlider.value()));
  dimShader.setUniform('spread', parseFloat(spreadSlider.value()));
  dimShader.setUniform('turbulence', parseFloat(turbulenceSlider.value()));
  dimShader.setUniform('time', 1.0);
  
  dimShader.setUniform('u_monotone', isMonotone ? 1.0 : 0.0);

  rect(0, 0, width, height);
}

function downloadProcessedImage() {
  if (!img) { alert("Please upload an image first."); return; }
  img = exportImg;
  resizeCanvas(img.width, img.height);
  draw(); 
  saveCanvas(`cinematic_${currentExportW}x${currentExportH}_blur`, 'jpg');
  img = previewImg;
  resizeCanvas(img.width, img.height);
}
