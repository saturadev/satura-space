Shader "Hidden/Satura/TunerSceneView"
{
    Properties
    {
        _MainTex ("Texture", 2D) = "white" {}
    }

    CGINCLUDE
    #include "UnityCG.cginc"

    sampler2D _SaturaTunerTex;
    float4 _SaturaTunerTexST;
    float4 _SaturaTunerColor;
    float _SaturaTunerVC;
    float _SaturaTunerSdf;
    float4 _SaturaTunerTexAdd;
    float _SaturaTunerClip;
    float4 _SaturaTunerMaskColor;
    float4 _SaturaTunerPickId;
    float4 _SaturaTunerUiClip;

    sampler2D _MainTex;
    float4 _MainTex_TexelSize;
    sampler2D _SaturaTunerMaskTex;
    float4 _SaturaTunerBlurDir;
    float4 _SaturaTunerParentColor;
    float4 _SaturaTunerChildColor;
    float _SaturaTunerOutlineGain;

    struct appdata
    {
        float4 vertex : POSITION;
        float2 uv : TEXCOORD0;
        float4 color : COLOR;
    };

    struct v2f
    {
        float4 pos : SV_POSITION;
        float2 uv : TEXCOORD0;
        float4 color : TEXCOORD1;
        float2 opos : TEXCOORD2;
    };

    v2f vert(appdata v)
    {
        v2f o;
        o.pos = mul(UNITY_MATRIX_VP, mul(unity_ObjectToWorld, float4(v.vertex.xyz, 1.0)));
        o.uv = v.uv * _SaturaTunerTexST.xy + _SaturaTunerTexST.zw;
        float4 vc = v.color;
        if (!IsGammaSpace()) vc.rgb = GammaToLinearSpace(vc.rgb);
        o.color = lerp(float4(1.0, 1.0, 1.0, 1.0), vc, _SaturaTunerVC);
        o.opos = v.vertex.xy;
        return o;
    }

    float coverage(v2f i)
    {
        float4 t = tex2D(_SaturaTunerTex, i.uv);
        if (_SaturaTunerSdf > 0.5)
        {
            float w = max(fwidth(t.a), 1e-4);
            t = float4(1.0, 1.0, 1.0, smoothstep(0.5 - w, 0.5 + w, t.a));
        }
        else t += _SaturaTunerTexAdd;
        return t.a * _SaturaTunerColor.a * i.color.a;
    }

    void uiClip(v2f i)
    {
        if (_SaturaTunerUiClip.x <= _SaturaTunerUiClip.z)
        {
            float2 inside = step(_SaturaTunerUiClip.xy, i.opos) * step(i.opos, _SaturaTunerUiClip.zw);
            clip(inside.x * inside.y - 0.5);
        }
    }

    float4 fragMask(v2f i) : SV_Target
    {
        uiClip(i);
        if (_SaturaTunerClip >= 0.0) clip(coverage(i) - _SaturaTunerClip);
        return _SaturaTunerMaskColor;
    }

    float4 fragPick(v2f i) : SV_Target
    {
        uiClip(i);
        if (_SaturaTunerClip >= 0.0) clip(coverage(i) - _SaturaTunerClip);
        return _SaturaTunerPickId;
    }

    struct vimg
    {
        float4 vertex : POSITION;
        float2 uv : TEXCOORD0;
    };

    struct v2i
    {
        float4 pos : SV_POSITION;
        float2 uv : TEXCOORD0;
    };

    v2i vertImg(vimg v)
    {
        v2i o;
        o.pos = UnityObjectToClipPos(v.vertex);
        o.uv = v.uv;
        return o;
    }

    float4 fragBlur(v2i i) : SV_Target
    {
        static const float w[5] = { 0.18871396, 0.1701919, 0.12483705, 0.07447626, 0.03613782 };
        float2 step = _SaturaTunerBlurDir.xy * _MainTex_TexelSize.xy;
        float4 sum = tex2D(_MainTex, i.uv) * w[0];
        for (int k = 1; k < 5; k++)
        {
            sum += tex2D(_MainTex, i.uv + step * k) * w[k];
            sum += tex2D(_MainTex, i.uv - step * k) * w[k];
        }
        return sum;
    }

    float4 fragOpaque(v2i i) : SV_Target
    {
        return float4(0.0, 0.0, 0.0, 1.0);
    }

    float4 fragComposite(v2i i) : SV_Target
    {
        float4 mask = tex2D(_SaturaTunerMaskTex, i.uv);
        float4 blur = tex2D(_MainTex, i.uv);
        float ap = mask.r > 0.5 ? 0.0 : saturate(blur.r * _SaturaTunerOutlineGain) * _SaturaTunerParentColor.a;
        float ac = mask.g > 0.5 ? 0.0 : saturate(blur.g * _SaturaTunerOutlineGain) * _SaturaTunerChildColor.a;
        float3 rgb = _SaturaTunerChildColor.rgb * ac + _SaturaTunerParentColor.rgb * ap * (1.0 - ac);
        return float4(rgb, ac + ap * (1.0 - ac));
    }
    ENDCG

    SubShader
    {
        Tags { "RenderType" = "Opaque" }

        Pass
        {
            Name "OutlineMask"
            Cull Off
            ZWrite Off
            ZTest Always
            Blend One One
            BlendOp Max
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragMask
            #pragma target 3.0
            ENDCG
        }

        Pass
        {
            Name "OutlineBlur"
            Cull Off
            ZWrite Off
            ZTest Always
            CGPROGRAM
            #pragma vertex vertImg
            #pragma fragment fragBlur
            #pragma target 3.0
            ENDCG
        }

        Pass
        {
            Name "OutlineComposite"
            Cull Off
            ZWrite Off
            ZTest Always
            Blend One OneMinusSrcAlpha
            CGPROGRAM
            #pragma vertex vertImg
            #pragma fragment fragComposite
            #pragma target 3.0
            ENDCG
        }

        Pass
        {
            Name "PickOpaque"
            Cull Off
            ZWrite On
            ZTest LEqual
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragPick
            #pragma target 3.0
            ENDCG
        }

        Pass
        {
            Name "OpaqueAlpha"
            Cull Off
            ZWrite Off
            ZTest Always
            ColorMask A
            CGPROGRAM
            #pragma vertex vertImg
            #pragma fragment fragOpaque
            #pragma target 3.0
            ENDCG
        }

        Pass
        {
            Name "PickTransparent"
            Cull Off
            ZWrite Off
            ZTest LEqual
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragPick
            #pragma target 3.0
            ENDCG
        }
    }
}
