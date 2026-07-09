import React, { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react'
import { ChevronRight, File as FileIcon, Folder, FolderOpen } from 'lucide-react-native'
import { Text, TouchableOpacity, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'

// ====================== Custom Collapsible ======================

type CollapsibleProps = {
  open: boolean
  children: ReactNode
}

const Collapsible = ({ open, children }: CollapsibleProps) => {
  const progress = useSharedValue(open ? 1 : 0)

  const animatedStyle = useAnimatedStyle(
    () => ({
      opacity: progress.value,
      maxHeight: progress.value * 9999,
    }),
    [progress.value]
  )

  React.useEffect(() => {
    progress.value = withTiming(open ? 1 : 0, { duration: 180 })
  }, [open])

  return <Animated.View style={animatedStyle}>{children}</Animated.View>
}

// ====================== Contexts ======================

interface FileTreeContextType {
  expandedPaths: Set<string>
  togglePath: (path: string) => void
  selectedPath?: string
  onSelect?: (path: string) => void
}

const FileTreeContext = createContext<FileTreeContextType>({
  expandedPaths: new Set(),
  togglePath: () => {},
})

interface FileTreeFolderContextType {
  path: string
  name: string
  isExpanded: boolean
}

const FileTreeFolderContext = createContext<FileTreeFolderContextType>({
  path: '',
  name: '',
  isExpanded: false,
})

// ====================== Main FileTree ======================

export type FileTreeProps = {
  expanded?: Set<string>
  defaultExpanded?: Set<string>
  selectedPath?: string
  onSelect?: (path: string) => void
  onExpandedChange?: (expanded: Set<string>) => void
  className?: string
  children: ReactNode
}

export const FileTree = ({
  expanded: controlledExpanded,
  defaultExpanded = new Set(),
  selectedPath,
  onSelect,
  onExpandedChange,
  className,
  children,
}: FileTreeProps) => {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded)

  const expandedPaths = controlledExpanded ?? internalExpanded

  const togglePath = useCallback(
    (path: string) => {
      const newExpanded = new Set(expandedPaths)
      if (newExpanded.has(path)) {
        newExpanded.delete(path)
      } else {
        newExpanded.add(path)
      }
      setInternalExpanded(newExpanded)
      onExpandedChange?.(newExpanded)
    },
    [expandedPaths, onExpandedChange]
  )

  const contextValue = useMemo(
    () => ({ expandedPaths, togglePath, selectedPath, onSelect }),
    [expandedPaths, togglePath, selectedPath, onSelect]
  )

  return (
    <FileTreeContext.Provider value={contextValue}>
      <View className={`overflow-hidden rounded-xl border border-border bg-background ${className || ''}`}>
        <View className="p-2">{children}</View>
      </View>
    </FileTreeContext.Provider>
  )
}

// ====================== Folder ======================

export type FileTreeFolderProps = {
  path: string
  name: string
  children?: ReactNode
  className?: string
}

export const FileTreeFolder = ({ path, name, children, className }: FileTreeFolderProps) => {
  const { expandedPaths, togglePath, selectedPath, onSelect } = useContext(FileTreeContext)

  const isExpanded = expandedPaths.has(path)
  const isSelected = selectedPath === path

  const handleToggle = useCallback(() => togglePath(path), [togglePath, path])
  const handleSelect = useCallback(() => onSelect?.(path), [onSelect, path])

  const folderContextValue = useMemo(() => ({ isExpanded, name, path }), [isExpanded, name, path])

  return (
    <FileTreeFolderContext.Provider value={folderContextValue}>
      <View className={className}>
        <TouchableOpacity
          activeOpacity={0.7}
          className={`flex-row items-center rounded-md px-2 py-1.5 ${isSelected ? 'bg-accent' : ''}`}
          onPress={handleSelect}
        >
          <TouchableOpacity activeOpacity={0.7} className="p-1" onPress={handleToggle}>
            <ChevronRight
              className="text-muted-foreground"
              size={18}
              style={{ transform: [{ rotate: isExpanded ? '90deg' : '0deg' }] }}
            />
          </TouchableOpacity>

          <TouchableOpacity activeOpacity={0.7} className="flex-1 flex-row items-center gap-2" onPress={handleSelect}>
            {isExpanded ? (
              <FolderOpen className="text-primary" size={18} />
            ) : (
              <Folder className="text-primary" size={18} />
            )}
            <Text className="flex-1 text-foreground text-sm" numberOfLines={1}>
              {name}
            </Text>
          </TouchableOpacity>
        </TouchableOpacity>

        <Collapsible open={isExpanded}>
          <View className="ml-6 border-border border-l pl-1">{children}</View>
        </Collapsible>
      </View>
    </FileTreeFolderContext.Provider>
  )
}

// ====================== File ======================

export type FileTreeFileProps = {
  path: string
  name: string
  icon?: ReactNode
  className?: string
}

export const FileTreeFile = ({ path, name, icon, className }: FileTreeFileProps) => {
  const { selectedPath, onSelect } = useContext(FileTreeContext)
  const isSelected = selectedPath === path

  const handlePress = useCallback(() => onSelect?.(path), [onSelect, path])

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      className={`flex-row items-center rounded-md px-2 py-1.5 ${isSelected ? 'bg-accent' : ''} ${className || ''}`}
      onPress={handlePress}
    >
      <View className="w-6.5" />
      <View className="flex-1 flex-row items-center gap-2">
        {icon ?? <FileIcon className="text-muted-foreground" size={18} />}
        <Text className="flex-1 text-foreground text-sm" numberOfLines={1}>
          {name}
        </Text>
      </View>
    </TouchableOpacity>
  )
}

// ====================== Actions ======================

export const FileTreeActions = ({ children, className }: { children: ReactNode; className?: string }) => {
  return <View className={`ml-auto flex-row items-center gap-1.5 ${className || ''}`}>{children}</View>
}
