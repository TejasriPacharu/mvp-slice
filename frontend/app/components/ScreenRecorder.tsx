'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { 
  saveVideo, 
  getVideo, 
  deleteVideo, 
  getAllRecordings, 
  generateRecordingId,
  RecordingMeta 
} from '@/lib/indexeddb';

// Maximum recording duration in milliseconds (3 minutes)
const MAX_RECORDING_DURATION = 3 * 60 * 1000;

export default function ScreenRecorder() {
  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [selectedRecording, setSelectedRecording] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recordingTime, setRecordingTime] = useState(0);
  
  // Microphone toggle state
  const [includeMic, setIncludeMic] = useState(true);
  
  // Refs for MediaRecorder and stream management
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null); // Separate ref for mic stream
  const audioContextRef = useRef<AudioContext | null>(null); // For mixing audio
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const autoStopTimerRef = useRef<NodeJS.Timeout | null>(null);
  const currentRecordingIdRef = useRef<string | null>(null);

  // Load all saved recordings on mount
  useEffect(() => {
    loadRecordings();
  }, []);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    };
  }, [videoUrl]);

  // Fetch all recordings from IndexedDB
  const loadRecordings = async () => {
    try {
      const allRecordings = await getAllRecordings();
      setRecordings(allRecordings);
    } catch (err) {
      console.error('Failed to load recordings:', err);
    }
  };

  // Play a selected recording
  const playRecording = useCallback(async (id: string) => {
    try {
      // Revoke previous URL to free memory
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      
      const blob = await getVideo(id);
      if (blob) {
        const url = URL.createObjectURL(blob);
        setVideoUrl(url);
        setSelectedRecording(id);
      }
    } catch (err) {
      console.error('Failed to load recording:', err);
      setError('Failed to load recording');
    }
  }, [videoUrl]);

  // Delete a recording
  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent triggering play
    try {
      await deleteVideo(id);
      // Clear player if deleted recording was playing
      if (selectedRecording === id) {
        if (videoUrl) URL.revokeObjectURL(videoUrl);
        setVideoUrl(null);
        setSelectedRecording(null);
      }
      await loadRecordings();
    } catch (err) {
      console.error('Failed to delete recording:', err);
    }
  }, [selectedRecording, videoUrl]);

  // Start screen recording
  const startRecording = useCallback(async () => {
    try {
      setError(null);
      chunksRef.current = [];
      currentRecordingIdRef.current = generateRecordingId();
      
      // Request screen sharing permission from the browser
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true, // System audio (if user selects "Share audio")
      });
      
      streamRef.current = screenStream;
      
      // Create the final stream that will be recorded
      let finalStream: MediaStream;
      
      if (includeMic) {
        try {
          // Request microphone access
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,  // Reduce echo
              noiseSuppression: true,  // Reduce background noise
              autoGainControl: true,   // Normalize volume levels
            },
            video: false,
          });
          
          micStreamRef.current = micStream;
          
          // Use Web Audio API to mix screen audio + mic audio
          const audioContext = new AudioContext();
          audioContextRef.current = audioContext;
          
          // Create a destination for the mixed audio
          const destination = audioContext.createMediaStreamDestination();
          
          // Add screen audio tracks to the mix (if present)
          const screenAudioTracks = screenStream.getAudioTracks();
          if (screenAudioTracks.length > 0) {
            const screenAudioStream = new MediaStream(screenAudioTracks);
            const screenSource = audioContext.createMediaStreamSource(screenAudioStream);
            screenSource.connect(destination);
          }
          
          // Add microphone audio to the mix
          const micSource = audioContext.createMediaStreamSource(micStream);
          micSource.connect(destination);
          
          // Create final stream: screen video + mixed audio
          finalStream = new MediaStream([
            ...screenStream.getVideoTracks(),        // Video from screen
            ...destination.stream.getAudioTracks(), // Mixed audio (screen + mic)
          ]);
          
        } catch (micError) {
          // If microphone access fails, continue with screen only
          console.warn('Microphone access denied, recording screen only:', micError);
          finalStream = screenStream;
        }
      } else {
        // No microphone requested, use screen stream as-is
        finalStream = screenStream;
      }
      
      // Determine supported MIME type for video recording
      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : MediaRecorder.isTypeSupported('video/webm')
        ? 'video/webm'
        : 'video/mp4';
      
      const mediaRecorder = new MediaRecorder(finalStream, { mimeType });
      mediaRecorderRef.current = mediaRecorder;
      
      // Collect video data chunks
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      
      // Handle recording stop
      mediaRecorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        
        // Save with unique ID
        if (currentRecordingIdRef.current) {
          await saveVideo(currentRecordingIdRef.current, blob);
          await loadRecordings();
          
          // Auto-play the new recording
          await playRecording(currentRecordingIdRef.current);
        }
        
        // Cleanup all streams and audio context
        streamRef.current?.getTracks().forEach(track => track.stop());
        micStreamRef.current?.getTracks().forEach(track => track.stop());
        audioContextRef.current?.close();
        
        if (timerRef.current) clearInterval(timerRef.current);
        if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
        
        setIsRecording(false);
        setRecordingTime(0);
      };
      
      // Handle user stopping screen share via browser UI
      screenStream.getVideoTracks()[0].onended = () => {
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      };
      
      // Start recording
      mediaRecorder.start(1000);
      setIsRecording(true);
      
      // Recording timer
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
      
      // Auto-stop after max duration
      autoStopTimerRef.current = setTimeout(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      }, MAX_RECORDING_DURATION);
      
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to start recording';
      setError(errorMessage);
      console.error('Recording error:', err);
    }
  }, [playRecording, includeMic]);

  // Stop recording manually
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  // Format seconds to MM:SS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Format timestamp to readable date
  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Format file size
  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div style={{ 
      padding: '2rem', 
      maxWidth: '900px', 
      margin: '0 auto',
      minHeight: '100vh',
    }}>
      {/* Header */}
      <h1 style={{ 
        marginBottom: '1.5rem',
        fontSize: '1.5rem',
        fontWeight: '600',
        color: '#111',
      }}>
        Screen Recorder
      </h1>
      
      {/* Error display */}
      {error && (
        <p style={{ 
          color: '#dc2626', 
          marginBottom: '1rem',
          padding: '0.75rem',
          backgroundColor: '#fef2f2',
          borderRadius: '6px',
          fontSize: '0.875rem',
        }}>
          {error}
        </p>
      )}
      
      {/* Recording controls */}
      <div style={{ marginBottom: '2rem' }}>
        {!isRecording ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
            <button
              onClick={startRecording}
              style={{
                padding: '12px 28px',
                fontSize: '15px',
                fontWeight: '500',
                cursor: 'pointer',
                backgroundColor: '#111',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                transition: 'background-color 0.2s',
              }}
              onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#333'}
              onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#111'}
            >
              ● Record Screen
            </button>
            
            {/* Microphone toggle */}
            <label style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              cursor: 'pointer',
              fontSize: '14px',
              color: '#444',
              userSelect: 'none',
            }}>
              <div 
                onClick={() => setIncludeMic(!includeMic)}
                style={{
                  width: '40px',
                  height: '22px',
                  backgroundColor: includeMic ? '#111' : '#ddd',
                  borderRadius: '11px',
                  position: 'relative',
                  transition: 'background-color 0.2s',
                  cursor: 'pointer',
                }}
              >
                <div style={{
                  width: '18px',
                  height: '18px',
                  backgroundColor: 'white',
                  borderRadius: '50%',
                  position: 'absolute',
                  top: '2px',
                  left: includeMic ? '20px' : '2px',
                  transition: 'left 0.2s',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </div>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                🎤 Microphone {includeMic ? 'On' : 'Off'}
              </span>
            </label>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 16px',
              backgroundColor: '#fef2f2',
              borderRadius: '8px',
            }}>
              <span style={{ 
                width: '10px',
                height: '10px',
                backgroundColor: '#dc2626',
                borderRadius: '50%',
                animation: 'pulse 1s infinite',
              }} />
              <span style={{ 
                fontFamily: 'monospace',
                fontSize: '14px',
                color: '#111',
              }}>
                {formatTime(recordingTime)}
              </span>
            </div>
            <button
              onClick={stopRecording}
              style={{
                padding: '12px 28px',
                fontSize: '15px',
                fontWeight: '500',
                cursor: 'pointer',
                backgroundColor: '#dc2626',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                transition: 'background-color 0.2s',
              }}
              onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#b91c1c'}
              onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#dc2626'}
            >
              ■ Stop
            </button>
          </div>
        )}
      </div>

      {/* Main content area */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: recordings.length > 0 ? '1fr 280px' : '1fr',
        gap: '24px',
      }}>
        {/* Video player */}
        <div>
          {videoUrl ? (
            <video
              src={videoUrl}
              controls
              autoPlay
              style={{ 
                width: '100%', 
                aspectRatio: '16/9',
                backgroundColor: '#000',
                borderRadius: '8px',
              }}
            />
          ) : (
            <div style={{
              width: '100%',
              aspectRatio: '16/9',
              backgroundColor: '#f5f5f5',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#999',
              fontSize: '14px',
            }}>
              {recordings.length > 0 
                ? 'Select a recording to play' 
                : 'No recordings yet. Click "Record Screen" to start.'}
            </div>
          )}
        </div>

        {/* Recordings list */}
        {recordings.length > 0 && (
          <div style={{
            backgroundColor: '#fff',
            borderRadius: '8px',
            border: '1px solid #e5e5e5',
            overflow: 'hidden',
          }}>
            <div style={{
              padding: '12px 16px',
              borderBottom: '1px solid #e5e5e5',
              fontSize: '13px',
              fontWeight: '600',
              color: '#666',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}>
              Recordings ({recordings.length})
            </div>
            <div style={{ 
              maxHeight: '400px', 
              overflowY: 'auto',
            }}>
              {recordings.map((rec) => (
                <div
                  key={rec.id}
                  onClick={() => playRecording(rec.id)}
                  style={{
                    padding: '12px 16px',
                    cursor: 'pointer',
                    borderBottom: '1px solid #f0f0f0',
                    backgroundColor: selectedRecording === rec.id ? '#f5f5f5' : 'transparent',
                    transition: 'background-color 0.15s',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                  onMouseOver={(e) => {
                    if (selectedRecording !== rec.id) {
                      e.currentTarget.style.backgroundColor = '#fafafa';
                    }
                  }}
                  onMouseOut={(e) => {
                    if (selectedRecording !== rec.id) {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }
                  }}
                >
                  <div>
                    <div style={{ 
                      fontSize: '14px', 
                      color: '#111',
                      marginBottom: '2px',
                    }}>
                      {formatDate(rec.timestamp)}
                    </div>
                    <div style={{ 
                      fontSize: '12px', 
                      color: '#888',
                    }}>
                      {formatSize(rec.size)}
                    </div>
                  </div>
                  <button
                    onClick={(e) => handleDelete(rec.id, e)}
                    style={{
                      padding: '4px 8px',
                      fontSize: '12px',
                      color: '#999',
                      backgroundColor: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      borderRadius: '4px',
                      transition: 'all 0.15s',
                    }}
                    onMouseOver={(e) => {
                      e.currentTarget.style.color = '#dc2626';
                      e.currentTarget.style.backgroundColor = '#fef2f2';
                    }}
                    onMouseOut={(e) => {
                      e.currentTarget.style.color = '#999';
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }}
                    title="Delete recording"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      
      {/* CSS for pulse animation */}
      <style jsx>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}