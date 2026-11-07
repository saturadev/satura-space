{
  "targets": [
    {
      "target_name": "shared_surface",
      "sources": [],
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/shared_surface_mac.mm"],
          "xcode_settings": {
            "OTHER_CFLAGS": ["-ObjC++", "-fobjc-arc"],
            "MACOSX_DEPLOYMENT_TARGET": "11.0"
          },
          "link_settings": {
            "libraries": [
              "$(SDKROOT)/System/Library/Frameworks/IOSurface.framework",
              "$(SDKROOT)/System/Library/Frameworks/CoreFoundation.framework",
              "$(SDKROOT)/System/Library/Frameworks/AppKit.framework"
            ]
          }
        }],
        ["OS=='win'", {
          "sources": ["src/shared_surface_win.cc"],
          "libraries": ["-ld3d11", "-ldxgi"]
        }]
      ],
      "include_dirs": [],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"]
    }
  ]
}
