package com.terminalcanvas

import java.awt.Image
import java.awt.Toolkit
import java.awt.datatransfer.DataFlavor
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.util.Base64
import javax.imageio.ImageIO

data class PasteData(
    val image: String? = null,
    val imageWidth: Int = 0,
    val imageHeight: Int = 0,
    val text: String = ""
)

object ClipboardHelper {
    fun readClipboard(): PasteData {
        var imageData: String? = null
        var imageWidth = 0
        var imageHeight = 0
        var text = ""

        try {
            val clipboard = Toolkit.getDefaultToolkit().systemClipboard

            // Try to read image
            if (clipboard.isDataFlavorAvailable(DataFlavor.imageFlavor)) {
                try {
                    val img = clipboard.getData(DataFlavor.imageFlavor) as? Image
                    if (img != null) {
                        val buffered = toBufferedImage(img)
                        imageWidth = buffered.width
                        imageHeight = buffered.height

                        val baos = ByteArrayOutputStream()
                        ImageIO.write(buffered, "png", baos)
                        val base64 = Base64.getEncoder().encodeToString(baos.toByteArray())
                        imageData = "data:image/png;base64,$base64"
                    }
                } catch (_: Exception) {
                    // Image read failed
                }
            }

            // Try to read text
            if (clipboard.isDataFlavorAvailable(DataFlavor.stringFlavor)) {
                try {
                    text = (clipboard.getData(DataFlavor.stringFlavor) as? String)?.trim() ?: ""
                } catch (_: Exception) {
                    // Text read failed
                }
            }
        } catch (_: Exception) {
            // Clipboard access failed
        }

        return PasteData(imageData, imageWidth, imageHeight, text)
    }

    private fun toBufferedImage(img: Image): BufferedImage {
        if (img is BufferedImage) return img

        val width = img.getWidth(null)
        val height = img.getHeight(null)
        val buffered = BufferedImage(
            if (width > 0) width else 400,
            if (height > 0) height else 300,
            BufferedImage.TYPE_INT_ARGB
        )
        val g = buffered.createGraphics()
        g.drawImage(img, 0, 0, null)
        g.dispose()
        return buffered
    }
}
