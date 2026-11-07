Shader "Hidden/Satura/TunerUnlit"
{
    CGINCLUDE
    #include "UnityCG.cginc"

    sampler2D _SaturaTunerTex;
    float4 _SaturaTunerTexST;
    float4 _SaturaTunerColor;
    float _SaturaTunerCutoff;
    float4 _SaturaTunerViewPos;
    float _SaturaTunerVC;
    float _SaturaTunerSdf;
    float _SaturaTunerFlat;
    float4 _SaturaTunerTexAdd;

    struct appdata
    {
        float4 vertex : POSITION;
        float3 normal : NORMAL;
        float2 uv : TEXCOORD0;
        float4 color : COLOR;
    };

    struct v2f
    {
        float4 pos : SV_POSITION;
        float2 uv : TEXCOORD0;
        float3 normal : TEXCOORD1;
        float3 world : TEXCOORD2;
        float4 color : TEXCOORD3;
    };

    v2f vert(appdata v)
    {
        v2f o;
        float4 w = mul(unity_ObjectToWorld, float4(v.vertex.xyz, 1.0));
        o.pos = mul(UNITY_MATRIX_VP, w);
        o.world = w.xyz;
        o.normal = UnityObjectToWorldNormal(v.normal);
        o.uv = v.uv * _SaturaTunerTexST.xy + _SaturaTunerTexST.zw;
        float4 vc = v.color;
        if (!IsGammaSpace()) vc.rgb = GammaToLinearSpace(vc.rgb);
        o.color = lerp(float4(1.0, 1.0, 1.0, 1.0), vc, _SaturaTunerVC);
        return o;
    }

    float4 shade(v2f i)
    {
        float4 t = tex2D(_SaturaTunerTex, i.uv);
        if (_SaturaTunerSdf > 0.5)
        {
            float w = max(fwidth(t.a), 1e-4);
            t = float4(1.0, 1.0, 1.0, smoothstep(0.5 - w, 0.5 + w, t.a));
        }
        else t += _SaturaTunerTexAdd;
        float4 c = t * _SaturaTunerColor * i.color;
        clip(c.a - _SaturaTunerCutoff);
        if (_SaturaTunerFlat > 0.5) return c;
        float3 n = normalize(i.normal);
        float3 v = normalize(_SaturaTunerViewPos.xyz - i.world);
        float facing = saturate(abs(dot(n, v)));
        float k = 0.47 + 0.4 * facing + 0.13 * (n.y * 0.5 + 0.5);
        return float4(c.rgb * k, c.a);
    }

    float4 fragOpaque(v2f i) : SV_Target
    {
        return float4(shade(i).rgb, 1.0);
    }

    float4 fragBlend(v2f i) : SV_Target
    {
        return shade(i);
    }
    ENDCG

    SubShader
    {
        Tags { "RenderType" = "Opaque" }

        Pass
        {
            Name "Opaque"
            Cull Off
            ZWrite On
            ZTest LEqual
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragOpaque
            #pragma target 3.0
            ENDCG
        }

        Pass
        {
            Name "Transparent"
            Cull Off
            ZWrite Off
            ZTest LEqual
            Blend SrcAlpha OneMinusSrcAlpha
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragBlend
            #pragma target 3.0
            ENDCG
        }

        Pass
        {
            Name "Depth"
            Cull Off
            ZWrite On
            ZTest LEqual
            ColorMask 0
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment fragOpaque
            #pragma target 3.0
            ENDCG
        }
    }
}
