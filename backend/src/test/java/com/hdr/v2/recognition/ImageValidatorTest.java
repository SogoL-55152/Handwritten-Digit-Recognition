package com.hdr.v2.recognition;

import com.hdr.v2.V2Exception;
import com.hdr.v2.platform.W2Limits;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.web.multipart.MultipartFile;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.util.HexFormat;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class ImageValidatorTest {
    private final ImageValidator validator = new ImageValidator();

    private byte[] image(String format, int width, int height, boolean ink, boolean transparent) throws Exception {
        BufferedImage image = new BufferedImage(width, height,
                transparent ? BufferedImage.TYPE_INT_ARGB : BufferedImage.TYPE_INT_RGB);
        var graphics = image.createGraphics();
        try {
            if (!transparent) {
                graphics.setColor(Color.WHITE);
                graphics.fillRect(0, 0, width, height);
            }
            if (ink) {
                graphics.setColor(Color.BLACK);
                graphics.fillRect(width / 3, height / 4, Math.max(1, width / 5), Math.max(1, height / 2));
            }
        } finally { graphics.dispose(); }
        var bytes = new ByteArrayOutputStream();
        assertTrue(ImageIO.write(image, format, bytes));
        return bytes.toByteArray();
    }

    private ImageValidator.Image validate(byte[] bytes) {
        return validator.validate(new MockMultipartFile("image", "untrusted.exe", "application/octet-stream", bytes));
    }

    @Test
    void detectsPngFromBytesAndPreservesExactDigest() throws Exception {
        byte[] bytes = image("png", 120, 80, true, false);
        var result = validate(bytes);
        assertEquals("image/png", result.contentType());
        assertArrayEquals(bytes, result.bytes());
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)), result.digest());
    }

    @Test
    void acceptsJpegAndTransparentInk() throws Exception {
        assertEquals("image/jpeg", validate(image("jpeg", 80, 120, true, false)).contentType());
        assertEquals("image/png", validate(image("png", 120, 80, true, true)).contentType());
    }

    @Test
    void rejectsWhiteAndFullyTransparentBlank() throws Exception {
        for (boolean transparent : new boolean[]{false, true}) {
            byte[] bytes = image("png", 28, 28, false, transparent);
            var error = assertThrows(V2Exception.class, () -> validate(bytes));
            assertEquals("BLANK_IMAGE", error.getCategory());
        }
    }

    @Test
    void rejectsUnsupportedCorruptAndEmptyImages() throws Exception {
        byte[][] inputs = {new byte[0], "not an image".getBytes(), image("gif", 28, 28, true, false)};
        for (byte[] bytes : inputs) assertEquals(400, assertThrows(V2Exception.class, () -> validate(bytes)).getStatus());
    }

    @Test
    void rejectsDimensionsBeforePixelDecode() throws Exception {
        byte[] bytes = image("png", 2049, 1, true, false);
        assertEquals("IMAGE_DIMENSIONS", assertThrows(V2Exception.class, () -> validate(bytes)).getCategory());
    }

    @Test
    void oversizedUploadIsRejectedBeforeReadingItsStream() throws Exception {
        MultipartFile file = mock(MultipartFile.class);
        when(file.getSize()).thenReturn(W2Limits.IMAGE_MAX_BYTES + 1);
        assertEquals(413, assertThrows(V2Exception.class, () -> validator.validate(file)).getStatus());
        verify(file, never()).getInputStream();
    }
}
