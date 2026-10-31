The PS3's own files, for the features that use them (firmware 4.93).

Copy them into THIS folder, next to this README:

  lines.qrc                  the Original Wave Style (the PS3's own wave)
  canyon.qrc                 the Music Player's Visual Player: Canyon
  earth.qrc                  the Music Player's Visual Player: Earth

RPCS3 has them once the PS3 firmware is installed in it:
  dev_flash/vsh/resource/qgl/lines.qrc, canyon.qrc, earth.qrc

Put here before building, they're included in your builds, like ffmpeg.
In an installed copy, this is the resources\ps3 folder in MaXMB's folder.
Without them, linkev's wave is used and the Visual Player shows only the
Visualizer Wave.
