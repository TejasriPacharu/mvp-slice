'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { 
  saveVideo, 
  getVideo, 
  deleteVideo, 
  getAllRecordings, 
  generateRecordingId,
  updateRecordingMeta,
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
  
  // Inline editing state for rename feature
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);
  
  // Refs for MediaRecorder and stream management
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
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

  // Focus input when editing starts
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

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
    e.stopPropagation();
    try {
      await deleteVideo(id);
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

  // Start inline editing for rename
  const startEditing = (rec: RecordingMeta, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(rec.id);
    setEditingName(rec.name);
  };

  // Save renamed recording
  const saveRename = async () => {
    if (!editingId || !editingName.trim()) {
      setEditingId(null);
      return;
    }
    
    try {
      await updateRecordingMeta(editingId, { name: editingName.trim() });
      await loadRecordings();
    } catch (err) {
      console.error('Failed to rename recording:', err);
    }
    
    setEditingId(null);
  };

  // Handle keyboard events for inline editing
  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      saveRename();
    } else if (e.key === 'Escape') {
      setEditingId(null);
    }
  };

  // Start screen recording
  const startRecording = useCallback(async () => {
    try {
      setError(null);
      chunksRef.current = [];
      currentRecordingIdRef.current = generateRecordingId();
      
      // Request screen sharing permission
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      
      streamRef.current = screenStream;
      let finalStream: MediaStream;
      
      if (includeMic) {
        try {
          // Request microphone access
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
            video: false,
          });
          
          micStreamRef.current = micStream;
          
          // Mix screen audio + mic audio using Web Audio API
          const audioContext = new AudioContext();
          audioContextRef.current = audioContext;
          const destination = audioContext.createMediaStreamDestination();
          
          // Add screen audio if present
          const screenAudioTracks = screenStream.getAudioTracks();
          if (screenAudioTracks.length > 0) {
            const screenAudioStream = new MediaStream(screenAudioTracks);
            const screenSource = audioContext.createMediaStreamSource(screenAudioStream);
            screenSource.connect(destination);
          }
          
          // Add microphone audio
          const micSource = audioContext.createMediaStreamSource(micStream);
          micSource.connect(destination);
          
          // Final stream: screen video + mixed audio
          finalStream = new MediaStream([
            ...screenStream.getVideoTracks(),
            ...destination.stream.getAudioTracks(),
          ]);
          
        } catch (micError) {
          console.warn('Microphone access denied, recording screen only:', micError);
          finalStream = screenStream;
        }
      } else {
        finalStream = screenStream;
      }
      
      // Determine supported MIME type
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
        const duration = recordingTime; // Capture current duration
        
        if (currentRecordingIdRef.current) {
          await saveVideo(currentRecordingIdRef.current, blob, duration);
          await loadRecordings();
          await playRecording(currentRecordingIdRef.current);
        }
        
        // Cleanup streams
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
  }, [playRecording, includeMic, recordingTime]);

  // Stop recording manually
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  // Format seconds to MM:SS
  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Format timestamp to readable date
  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  };

  // Format file size
  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="min-h-screen bg-gray-50 p-6 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        
        {/* Header */}
        <h1 className="text-2xl font-semibold text-gray-900">
          Screen Recorder
        </h1>
        
        {/* Error display */}
        {error && (
          <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
          </div>
        )}
        
        {/* Recording controls */}
        <div className="flex flex-wrap items-center gap-4">
          {!isRecording ? (
            <>
              <button
                onClick={startRecording}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-gray-900 text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2"
              >
                <span className="w-2 h-2 bg-red-500 rounded-full" />
                Record Screen
              </button>
              
              {/* Microphone toggle */}
              <button
                onClick={() => setIncludeMic(!includeMic)}
                className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg border transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                  includeMic 
                    ? 'bg-gray-900 text-white border-gray-900 hover:bg-gray-800 focus:ring-gray-900' 
                    : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50 focus:ring-gray-400'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                Mic {includeMic ? 'On' : 'Off'}
              </button>
            </>
          ) : (
            <div className="flex items-center gap-4">
              <div className="inline-flex items-center gap-2 px-4 py-2.5 bg-red-50 rounded-lg">
                <span className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
                <span className="font-mono text-sm text-gray-900">
                  {formatDuration(recordingTime)}
                </span>
              </div>
              <button
                onClick={stopRecording}
                className="inline-flex items-center gap-2 px-5 py-2.5 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 transition-colors focus:outline-none focus:ring-2 focus:ring-red-600 focus:ring-offset-2"
              >
                <span className="w-2.5 h-2.5 bg-white rounded-sm" />
                Stop
              </button>
            </div>
          )}
        </div>

        {/* Video Player */}
        <div className="rounded-xl overflow-hidden bg-black aspect-video">
          {videoUrl ? (
            <video
              src={videoUrl}
              controls
              autoPlay
              className="w-full h-full"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-500 text-sm">
              {recordings.length > 0 
                ? 'Select a recording to play' 
                : 'No recordings yet. Click "Record Screen" to start.'}
            </div>
          )}
        </div>

        {/* Recordings List - Vertical Layout */}
        {recordings.length > 0 && (
          <div className="space-y-3">
            <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wide">
              Recordings ({recordings.length})
            </h2>
            
            <div className="space-y-2">
              {recordings.map((rec) => (
                <div
                  key={rec.id}
                  onClick={() => playRecording(rec.id)}
                  className={`group flex items-center justify-between p-4 rounded-xl border cursor-pointer transition-all ${
                    selectedRecording === rec.id
                      ? 'bg-gray-100 border-gray-300'
                      : 'bg-white border-gray-200 hover:border-gray-300 hover:shadow-sm'
                  }`}
                >
                  {/* Left side: Name and metadata */}
                  <div className="flex-1 min-w-0 space-y-1">
                    {/* Recording name - inline editable */}
                    {editingId === rec.id ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={saveRename}
                        onKeyDown={handleEditKeyDown}
                        onClick={(e) => e.stopPropagation()}
                        className="w-full px-2 py-1 text-sm font-medium text-gray-900 bg-white border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-transparent"
                      />
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 truncate">
                          {rec.name}
                        </span>
                        {/* Edit/Rename button */}
                        <button
                          onClick={(e) => startEditing(rec, e)}
                          className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-gray-600 transition-opacity focus:opacity-100 focus:outline-none"
                          title="Rename"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </button>
                      </div>
                    )}
                    
                    {/* Metadata row: duration, size, date */}
                    <div className="flex items-center gap-3 text-xs text-gray-500">
                      {/* Duration */}
                      <span className="inline-flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        {formatDuration(rec.duration)}
                        console.log(rec.duration);
                      </span>
                      
                      {/* Size */}
                      <span className="inline-flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                        </svg>
                        {formatSize(rec.size)}
                      </span>
                      
                      {/* Date */}
                      <span className="inline-flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                        {formatDate(rec.timestamp)}
                      </span>
                    </div>
                  </div>
                  
                  {/* Right side: Actions */}
                  <div className="flex items-center gap-2 ml-4">
                    {/* Playing indicator */}
                    {selectedRecording === rec.id && (
                      <span className="text-xs font-medium text-gray-500 uppercase">
                        Playing
                      </span>
                    )}
                    
                    {/* Delete button */}
                    <button
                      onClick={(e) => handleDelete(rec.id, e)}
                      className="opacity-0 group-hover:opacity-100 p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all focus:opacity-100 focus:outline-none"
                      title="Delete recording"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}