(function(){
    'use strict';
    
    const FLAG_COUNT = 4;

    // 変数
    let gl, canvas;
    let program_scene, program_scene_centroid;
    
    let program_post;// 全画面描画（結果をキャンバスのフレームバッファにコピー）
    let mesh_full_screen;
    
    let mesh_flag = [];// 旗モデル
    let wMatrixRotate;
    
    // メッセージを更新
    let sendMessage = msg => document.getElementById('message').innerText = msg;
    
    // 状態管理
    const STATE = {
        NO_MSAA : "非MSAA",
        MSAA : "MSAA",
        MSAA_CENTROID : "Centroid 指定の MSAA",
    };
    let state = undefined;
    
    function ChangeState(){
        switch(state){
        case STATE.NO_MSAA: state = STATE.MSAA; break;
        case STATE.MSAA: state = STATE.MSAA_CENTROID; break;
        default: state = STATE.NO_MSAA; break;
        }
        
        sendMessage(state+": [SPACE]で更新");
    }

    window.addEventListener('load', function(){
        ////////////////////////////
        // 初期化
        ////////////////////////////

        // state 管理
        ChangeState();// 適当な値で強制更新することで初期化
        window.addEventListener("keydown", event => {if (event.keyCode === 32) ChangeState();} );// 空白押しで切り替え
        
        // canvas の初期化
        canvas = document.getElementById('canvas', {antialias: false});
        canvas.width = 512;
        canvas.height = 512;
        
        // WeebGLの初期化(WebGL 2.0)
        gl = canvas.getContext('webgl2');
        
        ////////////////////////////
        // プログラムオブジェクトの初期化
        
        // シーン描画用シェーダ
        const vsSourceScene = [
            '#version 300 es',
            'in vec3 position;',
            'in vec2 uv;',
           
            'uniform mat4 mpvwMatrix;',
            
            'out vec2 vTexCoord;',

            'void main(void) {',
                'gl_Position = mpvwMatrix * vec4(position.xyz, 1.0);',// 画面に表示される位置
                'vTexCoord = uv;',
            '}'
        ].join('\n');

        const vsSourceSceneCentroid = [
            '#version 300 es',
            'in vec3 position;',
            'in vec2 uv;',
           
            'uniform mat4 mpvwMatrix;',
            
            'centroid out vec2 vTexCoord;', // 重心化

            'void main(void) {',
                'gl_Position = mpvwMatrix * vec4(position.xyz, 1.0);',// 画面に表示される位置
                'vTexCoord = uv;',
            '}'
        ].join('\n');

        const fsSourceScene = [
            '#version 300 es',
            'precision highp float;',
            'in vec2 vTexCoord;',
            
            'uniform sampler2D samp;',

            'out vec4 outColor;',

            'void main(void) {',
                'outColor = vec4(texture(samp, vTexCoord).rgb, 1.0);',
            '}'
        ].join('\n');

        // ポストエフェクト
        const vsSourceFullScreen = [
            '#version 300 es',
            'in vec3 position;',
            'in vec2 uv;',
            
            'out vec2 vUv;',

            'void main(void) {',
                'gl_Position = vec4(position, 1.0);',
                'vUv = uv;',
            '}'
        ].join('\n');

        const fsSourcePost = [
            '#version 300 es',
            'precision highp float;',
            
            'in vec2 vUv;',
            
            'uniform sampler2D samp;',

            'out vec4 outColor;',

            'void main(void) {',
                'vec3 col = texture(samp, vUv).rgb;',
                'outColor  = vec4(col, 1.0);',
            '}',

        ].join('\n');

        // シェーダ「プログラム」の初期化
        program_scene          = create_program(vsSourceScene,         fsSourceScene, ['mpvwMatrix', 'samp']);
        program_scene_centroid = create_program(vsSourceSceneCentroid, fsSourceScene, ['mpvwMatrix', 'samp']);
        program_post           = create_program(vsSourceFullScreen,    fsSourcePost,  ['samp']);


        ////////////////////////////
        // フレームバッファオブジェクトの取得
        let fb     = create_framebuffer(canvas.width, canvas.height);
        let fbMSAA = create_framebuffer_msaa(canvas.width, canvas.height);

        ////////////////////////////
        // テクスチャの読み込み

        // 旗
        let flagTex = {tex:null};
        create_texture('img/flag.png', flagTex);

        ////////////////////////////
        // モデルの構築

        // 旗
        for(let i = 0; i < FLAG_COUNT; i++){
            let u_offset = (i & 1 === 1) ? 0.5 : 0.0;// 奇数か偶数
            let v_offset = (i >> 1=== 1) ? 0.5 : 0.0;// 2以下か以上か
            mesh_flag.push(
                createMesh(gl, program_scene.prg, [
                 // x    y     z       u             v 
                  +0.3,-0.2, 0.5,   0.5+u_offset, 0.5+v_offset,
                  +0.3,+0.2, 0.5,   0.5+u_offset, 0.0+v_offset,
                  -0.3,-0.2, 0.5,   0.0+u_offset, 0.5+v_offset,
                  -0.3,+0.2, 0.5,   0.0+u_offset, 0.0+v_offset,
                ], [0,1,2, 3,2,1])
            );
        }

        // 全画面を覆う三角形
        const vertex_data_full_screen = [
         // x    y     z     u    v
          -1.0,-1.0, +1.0,  0.0, 0.0,
          +3.0,-1.0, +1.0,  2.0, 0.0,
          -1.0,+3.0, +1.0,  0.0, 2.0,
        ];
        const index_data_full_screen = [0, 1, 2];
        mesh_full_screen = createMesh(gl, program_post.prg, vertex_data_full_screen, index_data_full_screen);

        ////////////////////////////
        // 各種行列の事前計算
        let mat = new matIV();// 行列のシステムのオブジェクト

        // シーンの情報の設定
        gl.enable(gl.DEPTH_TEST);
        gl.enable(gl.CULL_FACE);
        gl.clearColor(0,0,0,255);
        gl.clearDepth(1.0);

        ////////////////////////////
        // フレームの更新
        ////////////////////////////
        let lastTime = null;
        let angle = 0.0;// 物体を動かす角度

        window.requestAnimationFrame(update);
        
        function update(timestamp){
            ////////////////////////////
            // 動かす
            ////////////////////////////
            // 更新間隔の取得
            let elapsedTime = lastTime ? timestamp - lastTime : 0;
            lastTime = timestamp;

            // カメラを回すパラメータ
            angle += 0.0001 * elapsedTime;
            if(1.0 < angle) angle -= 1.0;
//angle = 0.325;
            // ワールド行列の生成
            wMatrixRotate = mat.identity(mat.create());
            mat.rotate(wMatrixRotate, 2.0 * Math.PI * angle, [0,0,1], wMatrixRotate);

            ////////////////////////////
            // 描画
            ////////////////////////////
            let bMSAA = (state !== STATE.NO_MSAA);
            
            ////////////////////////////
            // 浮動小数点数バッファへの作成
            if(bMSAA)
            {
                gl.bindFramebuffer(gl.FRAMEBUFFER, fbMSAA.f);
            }else{
                gl.bindFramebuffer(gl.FRAMEBUFFER, fb.f);
            }
            gl.viewport(0.0, 0.0, canvas.width, canvas.height);
            gl.clear(gl.DEPTH_BUFFER_BIT | gl.COLOR_BUFFER_BIT);

            if(flagTex.tex){
                let prg = program_scene;
                if(state === STATE.MSAA_CENTROID){
                    prg = program_scene_centroid;
                }

                gl.useProgram(prg.prg);
                gl.activeTexture(gl.TEXTURE0);
                gl.bindTexture(gl.TEXTURE_2D, flagTex.tex); // 盛り上げる形状
                gl.uniform1i(prg.loc[1], 0);// 'samp'
                for(let i = 0; i < FLAG_COUNT; i++){
                    let x_offset = (i & 1 === 1) ? 0.5 : -0.5;// 旗ごとに位置をずらす
                    let y_offset = (i >> 1=== 1) ? 0.5 : -0.5;
                    let m = mat.create();
                    mat.translate(mat.identity(mat.create()), [x_offset, y_offset, 0], m);
                    mat.multiply(m, wMatrixRotate, m);

                    gl.uniformMatrix4fv(prg.loc[0], false, m);// ワールド行列
                    gl.bindVertexArray(mesh_flag[i].vao);
                    gl.drawElements(gl.TRIANGLES, mesh_flag[i].count, gl.UNSIGNED_SHORT, 0);// 16ビット整数

                }
            }
            
            let tex = fb.t;
            if(bMSAA) 
            {
                resolve(fbMSAA);// 描画結果をテクスチャにコピー
                tex = fbMSAA.t;
            }
            
            ////////////////////////////
            // フレームバッファにコピー
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);// 通常のフレームバッファに戻す
            gl.viewport(0.0, 0.0, canvas.width, canvas.height);
        
            gl.disable(gl.DEPTH_TEST);// テストは無効
            gl.useProgram(program_post.prg);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.uniform1i(program_post.loc[0], 0); // 'samp'
            gl.bindVertexArray(mesh_full_screen.vao);
            gl.drawElements(gl.TRIANGLES, mesh_full_screen.count, gl.UNSIGNED_SHORT, 0);
            gl.enable(gl.DEPTH_TEST);// テストを戻す
            
            ////////////////////////////
            // 次のフレームへの処理
            ////////////////////////////
            gl.useProgram(null);
            gl.flush();
            window.requestAnimationFrame(update);
        }
        
    }, false);

    // シェーダの読み込み
    function load_shader(src, type)
    {
        let shader = gl.createShader(type);
        gl.shaderSource(shader, src);
        gl.compileShader(shader);
        if(!gl.getShaderParameter(shader, gl.COMPILE_STATUS)){
            alert(gl.getShaderInfoLog(shader));
        }
        return shader;
    }

    // プログラムオブジェクトの生成
    function create_program(vsSource, fsSource, uniform_names)
    {
        let prg = gl.createProgram();
        gl.attachShader(prg, load_shader(vsSource, gl.VERTEX_SHADER));
        gl.attachShader(prg, load_shader(fsSource, gl.FRAGMENT_SHADER));
        gl.linkProgram(prg);
        if(!gl.getProgramParameter(prg, gl.LINK_STATUS)){
            alert(gl.getProgramInfoLog(prg));
        }

        let uniLocations = [];
        uniform_names.forEach(function(value){
            uniLocations.push(gl.getUniformLocation(prg, value));
        });
        
        return {prg : prg, loc : uniLocations};
    }

    // テクスチャの読み込み
    function create_texture(src, dest)
    {
        // インスタンス用の配列
        let img;
        
        img = new loadImage();
        img.data.src = src; // ファイル名を指定
        
        // 画像のコンストラクタ
        function loadImage()
        {
            this.data = new Image();
            
            // 読み込まれた後の処理
            this.data.onload = function(){
                let tex = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, tex);// キューブマップとしてバインド
                    
                let width = img.data.width;
                let height = img.data.height;
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
                
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                // テクスチャのバインドを無効化
                gl.bindTexture(gl.TEXTURE_2D, null);
                
                dest.tex = tex;
            };
        }
    }

    // インデックス付き三角形リストの生成
    function createMesh(gl, program, vertex_data, index_data) {
        let vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        // 頂点バッファ
        const vertexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertex_data), gl.STATIC_DRAW);

        let posAttr = gl.getAttribLocation(program, 'position');
        gl.enableVertexAttribArray(posAttr);
        gl.vertexAttribPointer(posAttr, 3, gl.FLOAT, false, 4*5, 4*0);

        let uvAttr = gl.getAttribLocation(program, 'uv');
        gl.enableVertexAttribArray(uvAttr);
        gl.vertexAttribPointer(uvAttr, 2, gl.FLOAT, false, 4*5, 4*3);

        // インデックスバッファ
        let indexBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(index_data), gl.STATIC_DRAW);// 16ビット整数

        gl.bindVertexArray(null);

        return {vao : vao, count : index_data.length};
    };

    // フレームバッファの生成
    function create_framebuffer(width, height){
        // フレームバッファ
        let frameBuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer);
        
        // 深度バッファ
        let depthBuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, width, height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
        
        // 書き出し用テクスチャ
        let texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        
        // 各種オブジェクトを解除
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        
        // フレームバッファとテクスチャを返す
        return {f : frameBuffer, t : texture};
    }
    
    // フレームバッファの生成
    function create_framebuffer_msaa(width, height){
        // フレームバッファ
        let frameBuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, frameBuffer);
        
        var colorRenderbuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, colorRenderbuffer);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 16, gl.RGBA8, width, height);// MSAA化
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, colorRenderbuffer);
        
        // 深度バッファ
        let depthBuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, width, height);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, 16, gl.DEPTH_COMPONENT32F, width, height);// MSAA化
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthBuffer);
        
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);

        // 書き出し用テクスチャ
        let frameBufferResolve = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, frameBufferResolve);

        let texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        
        // 各種オブジェクトを解除
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        
        // フレームバッファとテクスチャを返す
        return {f : frameBuffer, f_resolve : frameBufferResolve, t : texture};
    }
    
    // MSAAの描画結果を非MSAAバッファに移す
    function resolve(frameBuffer){
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, frameBuffer.f);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, frameBuffer.f_resolve);
        gl.blitFramebuffer(// 全画面コピー
            0, 0, canvas.width, canvas.height,
            0, 0, canvas.width, canvas.height,
            gl.COLOR_BUFFER_BIT, gl.NEAREST
        );
    }
})();
